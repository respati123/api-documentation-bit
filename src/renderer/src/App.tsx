import { FormEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Cloud, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DebouncedInput, DebouncedTextarea } from '@/components/debounced-field'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { VariableInput, VariableTextarea, VariableUrlField, type VariableSuggestion } from '@/components/variable-field'
import { ApiReferencePage } from '@/components/api-reference'
import { ResponseEditor } from '@/components/response-editor'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ApiError, apiCall, apiWebSocketUrl, type ApiUser, type CloudCommit, type CloudCommitDetail, type CloudWorkspace } from '@/lib/api'
import { bodyModes, isBodyMode, mergeTreeSnapshots, stripLocalFilePaths, type BodyField, type BodyMode, type HeaderField, type ParamField, type RequestAuth, type ResponseContent, type ResponseDefinition, type SyncConflict, type SyncTreeNode } from '@/lib/merge'
import { diffText } from '@/lib/text-diff'
import { buildStagedSnapshot, getWorkspaceChanges, type WorkspaceChange } from '@/lib/workspace-changes'
import { activeVariableValues, emptyWorkspaceVariables, mergeWorkspaceVariables, normalizeWorkspaceVariables, preserveLocalSecretValues, resolveRequestVariables, shareableWorkspaceVariables, workspaceVariablesChangeId, workspaceVariablesDiffText, type WorkspaceEnvironment, type WorkspaceVariable, type WorkspaceVariables } from '@/lib/workspace-variables'
import { importOpenApi, serializeOpenApi } from '@/lib/openapi'

type SavedRequest = Extract<SyncTreeNode, { kind: 'request' }>
type Folder = Extract<SyncTreeNode, { kind: 'folder' }>
type TreeNode = SyncTreeNode
type WorkspaceTab = { kind: 'request'; id: string } | { kind: 'docs'; id: string } | { kind: 'environment'; id: string }
type WorkspaceHistoryCommit = { id: string; parentIds: string[]; message: string; tree?: unknown[]; variables?: WorkspaceVariables; createdAt: string; pushed: boolean; source: 'local' | 'cloud' }
type WorkspaceUpdateEvent = { type: 'workspace.updated'; workspaceId: string; headCommitId: string; message: string; actorEmail: string; commitCount: number }
type CollectionContextMenu = { x: number; y: number; parentFolderId: string; targetNodeId: string | null }
type DeleteConfirmTarget = { id: string; kind: 'folder' | 'request'; name: string }
type ResponseState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; data: ApiResponse }
type PendingMerge = { remoteHeadId: string; remoteTree: TreeNode[]; localTree: TreeNode[]; baseTree: TreeNode[]; localHeadId: string; conflicts: SyncConflict[]; remoteVariables: WorkspaceVariables; localVariables: WorkspaceVariables; baseVariables: WorkspaceVariables; variableConflict: boolean }

function WorkspaceStorageIcon({ kind, className }: { kind: 'cloud' | 'local'; className?: string }) {
  const Icon = kind === 'cloud' ? Cloud : HardDrive
  return <Icon aria-hidden="true" className={cn('workspace-storage-icon', `workspace-storage-icon-${kind}`, className)} size={16} strokeWidth={1.8} />
}

function CollectionFolderIcon({ open }: { open: boolean }) {
  const Icon = open ? FolderOpen : Folder
  return <Icon aria-hidden="true" className="folder-glyph" size={15} strokeWidth={1.8} />
}

const collectionWidthStorageKey = 'api-docs-collection-width'
const minCollectionWidth = 220
const maxCollectionWidth = 520

function collectionWidthLimit(): number {
  return Math.max(minCollectionWidth, Math.min(maxCollectionWidth, window.innerWidth * 0.38))
}

function clampCollectionWidth(width: number): number {
  return Math.max(minCollectionWidth, Math.min(collectionWidthLimit(), width))
}

function readCollectionWidth(): number {
  try {
    const stored = Number(localStorage.getItem(collectionWidthStorageKey))
    return clampCollectionWidth(Number.isFinite(stored) && stored > 0 ? stored : 280)
  } catch {
    return 280
  }
}

function workspaceTabKey(tab: WorkspaceTab): string { return `${tab.kind}:${tab.id}` }

function readWorkspaceTabs(workspaceId: string, tree: TreeNode[], variables: WorkspaceVariables): { tabs: WorkspaceTab[]; activeKey: string } {
  const requestIds = new Set<string>()
  const collectRequests = (nodes: TreeNode[]) => nodes.forEach((node) => node.kind === 'request' ? requestIds.add(node.id) : collectRequests(node.children))
  collectRequests(tree)
  const environmentIds = new Set(variables.environments.map((environment) => environment.id))
  const firstId = firstRequestId(tree)
  const fallback: WorkspaceTab[] = firstId ? [{ kind: 'request', id: firstId }] : []
  try {
    const stored = JSON.parse(localStorage.getItem(`api-docs-open-tabs-${workspaceId}`) ?? 'null') as { tabs?: unknown; activeKey?: unknown } | null
    const savedTabs = Array.isArray(stored?.tabs) ? stored.tabs as WorkspaceTab[] : []
    const seen = new Set<string>()
    const tabs = savedTabs.filter((tab): tab is WorkspaceTab => {
      if (!tab || !['request', 'docs', 'environment'].includes(tab.kind) || typeof tab.id !== 'string') return false
      if (tab.kind === 'environment' ? !environmentIds.has(tab.id) : !requestIds.has(tab.id)) return false
      const key = workspaceTabKey(tab)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const nextTabs = tabs.length ? tabs : fallback
    const activeKey = typeof stored?.activeKey === 'string' && nextTabs.some((tab) => workspaceTabKey(tab) === stored.activeKey)
      ? stored.activeKey
      : nextTabs[0] ? workspaceTabKey(nextTabs[0]) : ''
    return { tabs: nextTabs, activeKey }
  } catch {
    return { tabs: fallback, activeKey: fallback[0] ? workspaceTabKey(fallback[0]) : '' }
  }
}

const initialTree: TreeNode[] = [{
  id: 'example-api', kind: 'folder', name: 'Example API', children: [
    { id: 'list-users', kind: 'request', name: 'List users', method: 'GET', url: 'https://jsonplaceholder.typicode.com/users', body: '{\n  "name": ""\n}' },
    { id: 'create-user', kind: 'request', name: 'Create user', method: 'POST', url: 'https://jsonplaceholder.typicode.com/users', body: '{\n  "name": ""\n}' },
    { id: 'health-check', kind: 'request', name: 'Health check', method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts/1', body: '' }
  ]
}]

function isRequest(node: TreeNode): node is SavedRequest { return node.kind === 'request' }
function isFolder(node: TreeNode): node is Folder { return node.kind === 'folder' }

function requestHeaderCount(request: SavedRequest): number {
  const names = new Set((request.headers ?? [])
    .filter((header) => header.enabled && header.name.trim())
    .map((header) => header.name.trim().toLowerCase()))
  for (const name of ['accept', 'host', 'user-agent']) names.add(name)
  const bodyMode = request.bodyMode ?? (request.body.trim() ? 'json' : 'none')
  if (bodyMode !== 'none') names.add('content-type')
  const auth = request.auth ?? { type: 'none' as const }
  if (auth.type === 'bearer' && auth.token) names.add('authorization')
  if (auth.type === 'basic' && (auth.username || auth.password)) names.add('authorization')
  if (auth.type === 'api-key' && auth.location === 'header' && auth.name.trim() && auth.value) names.add(auth.name.trim().toLowerCase())
  return names.size
}

function redactDiffNode(node: TreeNode): TreeNode {
  if (isFolder(node)) return { ...node, children: node.children.map(redactDiffNode) }
  const shared = stripLocalFilePaths([node])[0] as SavedRequest
  const headers = shared.headers?.map((header) => ({ ...header, value: /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(header.name.trim()) && header.value ? '••••••' : header.value }))
  const auth: RequestAuth = shared.auth?.type === 'bearer' ? { ...shared.auth, token: shared.auth.token ? '••••••' : '' }
    : shared.auth?.type === 'basic' ? { ...shared.auth, password: shared.auth.password ? '••••••' : '' }
      : shared.auth?.type === 'api-key' ? { ...shared.auth, value: shared.auth.value ? '••••••' : '' }
        : shared.auth ?? { type: 'none' }
  return { ...shared, headers, auth }
}

function nodeDiffText(node: TreeNode | undefined): string {
  if (!node) return ''
  const safe = redactDiffNode(node)
  if (isFolder(safe)) return JSON.stringify(safe, null, 2)
  const shared = safe
  return JSON.stringify({ name: shared.name, method: shared.method, url: shared.url, pathParams: shared.pathParams ?? [], params: shared.params ?? [], auth: shared.auth ?? { type: 'none' }, headers: shared.headers ?? [], bodyMode: shared.bodyMode ?? (shared.body.trim() ? 'json' : 'none'), body: shared.body, bodyFields: shared.bodyFields, bodyVariables: shared.bodyVariables, bodyMimeType: shared.bodyMimeType, bodyFileName: shared.bodyFileName, documentation: shared.documentation ?? '', responses: shared.responses ?? [], openApiSchemas: shared.openApiSchemas }, null, 2)
}

function splitUrlParams(url: string): { url: string; params: ParamField[] } {
  const hashIndex = url.indexOf('#')
  const beforeHash = hashIndex < 0 ? url : url.slice(0, hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  if (queryIndex < 0 || queryIndex === beforeHash.length - 1) return { url, params: [] }
  const params = [...new URLSearchParams(beforeHash.slice(queryIndex + 1)).entries()].map(([name, value]) => ({ id: crypto.randomUUID(), name, value, enabled: true }))
  return { url, params }
}

function hasUrlQuery(url: string): boolean {
  const hashIndex = url.indexOf('#')
  return (hashIndex < 0 ? url : url.slice(0, hashIndex)).includes('?')
}

function mergeUrlParamRows(urlParams: ParamField[], existingParams: ParamField[]): ParamField[] {
  const remaining = [...existingParams]
  const merged = urlParams.map((param) => {
    let index = remaining.findIndex((item) => item.name === param.name && item.value === param.value)
    if (index < 0) index = remaining.findIndex((item) => item.name === param.name)
    if (index < 0) return param
    const [previous] = remaining.splice(index, 1)
    return { ...previous, name: param.name, value: param.value }
  })
  return [...merged, ...remaining]
}

function syncUrlParams(url: string, existingParams: ParamField[]): ParamField[] {
  const parsedParams = splitUrlParams(url).params
  const unused = new Set(existingParams.map((param) => param.id))
  return parsedParams.map((param, index) => {
    const findExisting = (predicate: (item: ParamField) => boolean) => existingParams.find((item) => unused.has(item.id) && predicate(item))
    const previous = findExisting((item) => item.name === param.name && item.value === param.value)
      ?? findExisting((item) => item.name === param.name)
      ?? (existingParams[index] && unused.has(existingParams[index].id) ? existingParams[index] : undefined)
    if (!previous) return param
    unused.delete(previous.id)
    return { ...previous, name: param.name, value: param.value }
  })
}

function encodeQueryComponent(value: string): string {
  const variableToken = /\{\{\s*[^{}]+?\s*\}\}/g
  let result = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = variableToken.exec(value))) {
    result += `${encodeURIComponent(value.slice(cursor, match.index))}${match[0]}`
    cursor = match.index + match[0].length
  }
  return `${result}${encodeURIComponent(value.slice(cursor))}`
}

function replaceUrlParams(url: string, params: ParamField[]): string {
  const hashIndex = url.indexOf('#')
  const beforeHash = hashIndex < 0 ? url : url.slice(0, hashIndex)
  const hash = hashIndex < 0 ? '' : url.slice(hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  const base = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex)
  const query = params.filter((param) => param.name.trim()).map((param) => `${encodeQueryComponent(param.name)}=${encodeQueryComponent(param.value)}`).join('&')
  return `${base}${query ? `?${query}` : ''}${hash}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildCurlCommand(request: SavedRequest): string {
  const mode = request.bodyMode ?? (request.body.trim() ? 'json' : 'none')
  const auth = request.auth ?? { type: 'none' as const }
  const headers = new Map<string, { name: string; value: string }>()
  for (const header of request.headers ?? []) {
    if (header.enabled && header.name.trim()) headers.set(header.name.trim().toLowerCase(), { name: header.name.trim(), value: header.value })
  }
  if (!headers.has('accept')) headers.set('accept', { name: 'Accept', value: '*/*' })
  if (!headers.has('user-agent')) headers.set('user-agent', { name: 'User-Agent', value: 'API-Documentation/0.1.0' })

  let targetUrl = request.url
  try {
    const url = new URL(request.url)
    url.search = ''
    for (const param of request.params ?? []) if (param.enabled && param.name.trim()) url.searchParams.append(param.name, param.value)
    if (auth.type === 'api-key' && auth.location === 'query' && auth.name.trim() && auth.value) url.searchParams.append(auth.name, auth.value)
    targetUrl = url.toString()
  } catch { /* Keep the entered URL so the generated command remains editable. */ }

  if (auth.type === 'bearer' && auth.token) headers.set('authorization', { name: 'Authorization', value: `Bearer ${auth.token}` })
  if (auth.type === 'basic' && (auth.username || auth.password)) {
    const bytes = new TextEncoder().encode(`${auth.username}:${auth.password}`)
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    headers.set('authorization', { name: 'Authorization', value: `Basic ${btoa(binary)}` })
  }
  if (auth.type === 'api-key' && auth.location === 'header' && auth.name.trim() && auth.value) headers.set(auth.name.trim().toLowerCase(), { name: auth.name.trim(), value: auth.value })

  if (mode !== 'none' && mode !== 'form-data' && !headers.has('content-type')) {
    const contentType = mode === 'urlencoded' ? 'application/x-www-form-urlencoded;charset=UTF-8'
      : mode === 'file' ? request.bodyMimeType || 'application/octet-stream'
        : mode === 'other' ? request.bodyMimeType || 'text/plain' : bodyContentType(mode)
    headers.set('content-type', { name: 'Content-Type', value: contentType })
  }
  if (mode === 'form-data') headers.delete('content-type')

  const parts = ['curl', '--request', shellQuote(request.method.toUpperCase()), shellQuote(targetUrl)]
  for (const header of headers.values()) parts.push('--header', shellQuote(`${header.name}: ${header.value}`))
  const canSendBody = !['GET', 'HEAD'].includes(request.method.toUpperCase()) && mode !== 'none'
  if (canSendBody && mode === 'form-data') {
    for (const field of request.bodyFields ?? []) {
      if (!field.enabled || !field.name) continue
      const value = field.type === 'file' ? `@${field.filePath || field.fileName || ''}` : `${field.name}=${field.value}`
      parts.push('--form', shellQuote(field.type === 'file' ? `${field.name}=${value}` : value))
    }
  } else if (canSendBody && mode === 'urlencoded') {
    for (const field of request.bodyFields ?? []) if (field.enabled && field.name) parts.push('--data-urlencode', shellQuote(`${field.name}=${field.value}`))
  } else if (canSendBody && mode === 'file') {
    if (request.bodyPath) parts.push('--data-binary', shellQuote(`@${request.bodyPath}`))
  } else if (canSendBody && mode === 'graphql') {
    let variables: unknown = {}
    try { variables = JSON.parse(request.bodyVariables || '{}') } catch { variables = request.bodyVariables || '{}' }
    parts.push('--data-raw', shellQuote(JSON.stringify({ query: request.body, variables })))
  } else if (canSendBody) {
    parts.push('--data-raw', shellQuote(request.body))
  }
  return parts.join(' ')
}

function toApiRequest(request: SavedRequest): ApiRequest {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers ?? [],
    params: request.params ?? [],
    auth: request.auth ?? { type: 'none' },
    body: request.body,
    bodyMode: request.bodyMode ?? (request.body.trim() ? 'json' : 'none'),
    bodyFields: request.bodyFields ?? [],
    bodyVariables: request.bodyVariables ?? '{}',
    bodyMimeType: request.bodyMimeType,
    bodyPath: request.bodyPath,
    bodyFileName: request.bodyFileName
  }
}

function downloadResponse(data: ApiResponse, requestName: string): void {
  const contentType = data.headers['content-type'] ?? ''
  const extension = /\bjson\b/i.test(contentType) ? 'json' : 'txt'
  const filename = requestName.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'response'
  const url = URL.createObjectURL(new Blob([data.body], { type: contentType || 'text/plain' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${filename}.${extension}`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function responseCookies(data: ApiResponse): string[] {
  if (data.cookies?.length) return data.cookies
  const combined = data.headers['set-cookie']
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=)/).map((cookie) => cookie.trim()).filter(Boolean) : []
}

function cookieParts(cookie: string): { name: string; value: string; attributes: string[] } {
  const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim())
  const separator = pair.indexOf('=')
  return { name: separator < 0 ? pair : pair.slice(0, separator), value: separator < 0 ? '' : pair.slice(separator + 1), attributes }
}

const ResponseInspector = memo(function ResponseInspector({ response, responseView, onResponseViewChange }: {
  response: ResponseState
  responseView: 'body' | 'headers' | 'cookies'
  onResponseViewChange: (view: 'body' | 'headers' | 'cookies') => void
}) {
  const formattedBody = useMemo(() => {
    if (response.kind !== 'success') return ''
    try { return JSON.stringify(JSON.parse(response.data.body), null, 2) } catch { return response.data.body }
  }, [response])
  const responseCookieRows = useMemo(() => response.kind === 'success' ? responseCookies(response.data).map(cookieParts) : [], [response])
  return <section className="response-card" aria-live="polite" aria-busy={response.kind === 'loading'}>
    <div className="response-heading"><div><p className="section-kicker">Inspector</p><h2>Response</h2></div>{response.kind === 'success' && <div className="response-meta"><span className={cn('status-code', response.data.status >= 400 && 'status-code-error')}>{response.data.status} {response.data.statusText}</span><span>{response.data.duration} ms</span></div>}</div>
    {response.kind === 'empty' && <StateMessage title="No response yet" description="Send the request to inspect status, headers, timing, and body." />}
    {response.kind === 'loading' && <StateMessage title="Sending request" description="Waiting for the server response." />}
    {response.kind === 'error' && <StateMessage error title="Request failed" description={response.message} />}
    {response.kind === 'success' && <Tabs value={responseView} onValueChange={(value) => onResponseViewChange(value as typeof responseView)} className="response-tabs">
      <TabsList aria-label="Response details" className="response-tab-list">
        <TabsTrigger value="body">Body</TabsTrigger>
        <TabsTrigger value="headers">Headers <span className="response-tab-count">{Object.keys(response.data.headers).length}</span></TabsTrigger>
        <TabsTrigger value="cookies">Cookies <span className="response-tab-count">{responseCookieRows.length}</span></TabsTrigger>
      </TabsList>
      <TabsContent value="body" className="response-tab-pane"><ScrollArea className="response-scroll"><pre>{formattedBody || 'Response body is empty.'}</pre></ScrollArea></TabsContent>
      <TabsContent value="headers" className="response-tab-pane"><ScrollArea className="response-data-scroll">
        {Object.entries(response.data.headers).length ? <dl className="response-key-values">{Object.entries(response.data.headers).map(([name, value]) => <div className="response-key-value" key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : <div className="response-empty-detail">The server did not return any headers.</div>}
      </ScrollArea></TabsContent>
      <TabsContent value="cookies" className="response-tab-pane"><ScrollArea className="response-data-scroll">
        {responseCookieRows.length ? <dl className="response-cookie-list">{responseCookieRows.map((cookie, index) => <div className="response-cookie" key={`${cookie.name}-${index}`}><dt>{cookie.name || `Cookie ${index + 1}`}</dt><dd><code>{cookie.value}</code>{cookie.attributes.length > 0 && <small>{cookie.attributes.join(' · ')}</small>}</dd></div>)}</dl> : <div className="response-empty-detail">No Set-Cookie headers were returned.</div>}
      </ScrollArea></TabsContent>
    </Tabs>}
  </section>
})

function migrateNode(value: unknown): TreeNode | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (item.kind === 'request' && typeof item.id === 'string') {
    const body = typeof item.body === 'string' ? item.body : ''
    const url = typeof item.url === 'string' ? item.url : ''
    const storedParams = Array.isArray(item.params) ? item.params.filter(isParamField) : []
    const parsedUrl = splitUrlParams(url)
    const params = hasUrlQuery(url) ? mergeUrlParamRows(parsedUrl.params, storedParams) : Array.isArray(item.params) ? storedParams : parsedUrl.params
    const synchronizedUrl = hasUrlQuery(url) && params.length !== parsedUrl.params.length
      ? replaceUrlParams(url, params)
      : !hasUrlQuery(url) && params.length ? replaceUrlParams(url, params) : url
    return {
      ...item,
      url: synchronizedUrl,
      params,
      auth: isRequestAuth(item.auth) ? item.auth : { type: 'none' },
      body,
      bodyMode: isBodyMode(item.bodyMode) ? item.bodyMode : body.trim() ? 'json' : 'none',
      bodyFields: Array.isArray(item.bodyFields) ? item.bodyFields.filter(isBodyField) : [],
      headers: Array.isArray(item.headers) ? item.headers.filter(isHeaderField) : [{ id: crypto.randomUUID(), name: 'Accept', value: '*/*', enabled: true }],
      pathParams: Array.isArray(item.pathParams) ? item.pathParams.filter(isParamField) : [],
      documentation: typeof item.documentation === 'string' ? item.documentation : '',
      responses: normalizeResponseDefinitions(item.responses),
      ...(item.openApiSchemas && typeof item.openApiSchemas === 'object' && !Array.isArray(item.openApiSchemas) ? { openApiSchemas: item.openApiSchemas as Record<string, unknown> } : {})
    } as unknown as SavedRequest
  }
  if (item.kind === 'folder' && typeof item.id === 'string' && Array.isArray(item.children)) {
    return { id: item.id, kind: 'folder', name: String(item.name || 'Untitled folder'), children: item.children.map(migrateNode).filter((node): node is TreeNode => node !== null) }
  }
  // Keep collections and requests created by the previous version.
  if (typeof item.id === 'string' && Array.isArray(item.requests)) {
    const children = item.requests.map((request) => {
      if (!request || typeof request !== 'object') return null
      const saved = request as Record<string, unknown>
      if (typeof saved.id !== 'string') return null
      const url = String(saved.url || '')
      const migratedUrl = splitUrlParams(url)
      return { id: saved.id, kind: 'request' as const, name: String(saved.name || 'Untitled request'), method: String(saved.method || 'GET'), url: migratedUrl.url, body: String(saved.body || ''), headers: [{ id: crypto.randomUUID(), name: 'Accept', value: '*/*', enabled: true }], params: migratedUrl.params, auth: { type: 'none' as const } }
    }).filter((node): node is SavedRequest => node !== null)
    return { id: item.id, kind: 'folder', name: String(item.name || 'Untitled folder'), children }
  }
  return null
}

function readTree(): TreeNode[] {
  try {
    const stored = localStorage.getItem('api-docs-workspace') ?? localStorage.getItem('api-docs-collections')
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      if (Array.isArray(parsed)) return parsed.map(migrateNode).filter((node): node is TreeNode => node !== null)
    }
  } catch {
    localStorage.removeItem('api-docs-workspace')
    localStorage.removeItem('api-docs-collections')
  }
  return initialTree
}

function normalizeTree(value: unknown): TreeNode[] {
  return Array.isArray(value) ? value.map(migrateNode).filter((node): node is TreeNode => node !== null) : []
}

function normalizeSharedTree(value: unknown): TreeNode[] {
  return stripLocalFilePaths(normalizeTree(value))
}

function normalizeSharedVariables(value: unknown): WorkspaceVariables {
  return shareableWorkspaceVariables(normalizeWorkspaceVariables(value))
}

function isBodyField(value: unknown): value is BodyField {
  if (!value || typeof value !== 'object') return false
  const field = value as Record<string, unknown>
  return typeof field.id === 'string' && typeof field.name === 'string' && typeof field.value === 'string' && typeof field.enabled === 'boolean' && (field.type === 'text' || field.type === 'file') && (field.filePath === undefined || typeof field.filePath === 'string') && (field.fileName === undefined || typeof field.fileName === 'string')
}

function normalizeResponseDefinitions(value: unknown): ResponseDefinition[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ResponseDefinition[] => {
    if (!item || typeof item !== 'object') return []
    const response = item as Record<string, unknown>
    if (typeof response.statusCode !== 'string') return []
    const content: ResponseContent[] = Array.isArray(response.content) ? response.content.flatMap((entry): ResponseContent[] => {
      if (!entry || typeof entry !== 'object') return []
      const media = entry as Record<string, unknown>
      if (typeof media.mediaType !== 'string') return []
      return [{ id: typeof media.id === 'string' ? media.id : crypto.randomUUID(), mediaType: media.mediaType, schema: typeof media.schema === 'string' ? media.schema : '', example: typeof media.example === 'string' ? media.example : '' }]
    }) : []
    return [{ id: typeof response.id === 'string' ? response.id : crypto.randomUUID(), statusCode: response.statusCode, description: typeof response.description === 'string' ? response.description : '', content }]
  })
}

function isHeaderField(value: unknown): value is HeaderField {
  if (!value || typeof value !== 'object') return false
  const field = value as Record<string, unknown>
  return typeof field.id === 'string' && typeof field.name === 'string' && typeof field.value === 'string' && typeof field.enabled === 'boolean' && (field.description === undefined || typeof field.description === 'string')
}

function isParamField(value: unknown): value is ParamField {
  if (!value || typeof value !== 'object') return false
  const field = value as Record<string, unknown>
  return typeof field.id === 'string' && typeof field.name === 'string' && typeof field.value === 'string' && typeof field.enabled === 'boolean' && (field.description === undefined || typeof field.description === 'string')
}

function isRequestAuth(value: unknown): value is RequestAuth {
  if (!value || typeof value !== 'object') return false
  const auth = value as Record<string, unknown>
  if (auth.type === 'none') return true
  if (auth.type === 'bearer') return typeof auth.token === 'string'
  if (auth.type === 'basic') return typeof auth.username === 'string' && typeof auth.password === 'string'
  return auth.type === 'api-key' && typeof auth.name === 'string' && typeof auth.value === 'string' && (auth.location === 'header' || auth.location === 'query')
}

function readStagedSnapshot(workspaceId: string): TreeNode[] | null {
  try {
    const value = localStorage.getItem(`api-docs-staged-${workspaceId}`)
    if (!value) return null
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(migrateNode).filter((node): node is TreeNode => node !== null) : null
  } catch { return null }
}

function readStagedVariables(workspaceId: string): WorkspaceVariables | null {
  try {
    const value = localStorage.getItem(`api-docs-staged-variables-${workspaceId}`)
    if (!value) return null
    return normalizeSharedVariables(JSON.parse(value))
  } catch { return null }
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    if (isFolder(node)) {
      const nested = findNode(node.children, id)
      if (nested) return nested
    }
  }
}

function findParentFolder(nodes: TreeNode[], id: string, parentId = ''): string {
  for (const node of nodes) {
    if (node.id === id) return parentId
    if (isFolder(node)) {
      const result = findParentFolder(node.children, id, node.id)
      if (result !== '') return result
    }
  }
  return ''
}

function indexTree(nodes: TreeNode[]) {
  const nodeById = new Map<string, TreeNode>()
  const parentFolderById = new Map<string, string>()
  const requestCountByFolderId = new Map<string, number>()
  const visit = (items: TreeNode[], parentId = ''): number => {
    let requestCount = 0
    for (const node of items) {
      nodeById.set(node.id, node)
      parentFolderById.set(node.id, parentId)
      if (isFolder(node)) {
        const childCount = visit(node.children, node.id)
        requestCountByFolderId.set(node.id, childCount)
        requestCount += childCount
      } else requestCount += 1
    }
    return requestCount
  }
  visit(nodes)
  return { nodeById, parentFolderById, requestCountByFolderId }
}

function updateNode(nodes: TreeNode[], id: string, patch: Partial<SavedRequest>): TreeNode[] {
  let changed = false
  const updated = nodes.map((node) => {
    if (node.id === id && isRequest(node)) {
      changed = true
      return { ...node, ...patch }
    }
    if (!isFolder(node)) return node
    const children = updateNode(node.children, id, patch)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  return changed ? updated : nodes
}

function renameFolder(nodes: TreeNode[], id: string, name: string): TreeNode[] {
  return nodes.map((node) => isFolder(node)
    ? node.id === id ? { ...node, name } : { ...node, children: renameFolder(node.children, id, name) }
    : node)
}

function removeNode(nodes: TreeNode[], id: string): { nodes: TreeNode[]; removed?: TreeNode } {
  const kept: TreeNode[] = []
  let removed: TreeNode | undefined
  for (const node of nodes) {
    if (node.id === id) removed = node
    else if (isFolder(node)) {
      const result = removeNode(node.children, id)
      if (result.removed) removed = result.removed
      kept.push({ ...node, children: result.nodes })
    } else kept.push(node)
  }
  return { nodes: kept, removed }
}

function containsId(node: TreeNode, id: string): boolean {
  return node.id === id || (isFolder(node) && node.children.some((child) => containsId(child, id)))
}

function insertNode(nodes: TreeNode[], item: TreeNode, targetId: string | null): TreeNode[] {
  if (!targetId) return [...nodes, item]
  const target = findNode(nodes, targetId)
  if (!target) return [...nodes, item]
  if (isFolder(target)) {
    return nodes.map((node) => node.id === targetId ? { ...node, children: [...node.children, item] } : isFolder(node) ? { ...node, children: insertNode(node.children, item, targetId) } : node)
  }
  return nodes.flatMap((node) => {
    if (node.id === targetId) return [item, node]
    if (isFolder(node)) return [{ ...node, children: insertNode(node.children, item, targetId) }]
    return [node]
  })
}

function VariableRows({ rows, readOnly, onChange }: { rows: WorkspaceVariable[]; readOnly: boolean; onChange: (rows: WorkspaceVariable[]) => void }) {
  function update(id: string, patch: Partial<WorkspaceVariable>) {
    onChange(rows.map((row) => row.id === id ? { ...row, ...patch } : row))
  }

  return <div className="variable-scope-body">
    <div className="variable-table" role="table" aria-label="Variables">
      <div className="variable-table-heading" role="row"><span role="columnheader">Name</span><span role="columnheader">Value</span><span role="columnheader">Secret</span><span aria-hidden="true" /></div>
      {rows.map((row, index) => <div className="variable-table-row" role="row" key={row.id}>
        <Input aria-label={`Variable name ${index + 1}`} maxLength={160} value={row.name} readOnly={readOnly} onChange={(event) => update(row.id, { name: event.target.value })} placeholder="e.g. baseUrl" />
        <Input aria-label={`Variable value ${index + 1}`} type={row.secret ? 'password' : 'text'} autoComplete="off" value={row.value} readOnly={readOnly && !row.secret} onChange={(event) => update(row.id, { value: event.target.value })} placeholder={row.secret ? 'Secret value stays local' : 'Value'} />
        <label className="variable-secret-toggle"><input type="checkbox" checked={row.secret} disabled={readOnly} onChange={(event) => update(row.id, { secret: event.target.checked })} /><span>Secret</span></label>
        <Button type="button" variant="ghost" size="sm" className="variable-remove" aria-label={`Delete variable ${row.name || index + 1}`} disabled={readOnly} onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>×</Button>
      </div>)}
      {!rows.length && <p className="variable-empty">No variables yet.</p>}
    </div>
    <Button type="button" variant="outline" size="sm" className="variable-add" disabled={readOnly || rows.length >= 500} onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: '', value: '', secret: false }])}>Add variable</Button>
  </div>
}

function VariablesDialog({ open, onOpenChange, variables, activeEnvironmentId, readOnly, secureStorageAvailable, onVariablesChange, onActiveEnvironmentChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  variables: WorkspaceVariables
  activeEnvironmentId: string | null
  readOnly: boolean
  secureStorageAvailable: boolean
  onVariablesChange: (variables: WorkspaceVariables) => void
  onActiveEnvironmentChange: (environmentId: string | null) => void
}) {
  const [scope, setScope] = useState('global')
  const [environmentNameDraft, setEnvironmentNameDraft] = useState('')
  const selectedEnvironment = variables.environments.find((environment) => environment.id === activeEnvironmentId)

  function updateGlobalRows(rows: WorkspaceVariable[]) {
    onVariablesChange({ ...variables, globals: rows })
  }

  function updateEnvironment(patch: Partial<WorkspaceEnvironment>) {
    if (!selectedEnvironment) return
    onVariablesChange({
      ...variables,
      environments: variables.environments.map((environment) => environment.id === selectedEnvironment.id ? { ...environment, ...patch } : environment)
    })
  }

  function createEnvironment(event: FormEvent) {
    event.preventDefault()
    const name = environmentNameDraft.trim()
    if (readOnly || !name) return
    const environment = { id: crypto.randomUUID(), name, variables: [] }
    onVariablesChange({ ...variables, environments: [...variables.environments, environment] })
    onActiveEnvironmentChange(environment.id)
    setEnvironmentNameDraft('')
  }

  function deleteEnvironment() {
    if (!selectedEnvironment || readOnly) return
    const remaining = variables.environments.filter((environment) => environment.id !== selectedEnvironment.id)
    onVariablesChange({ ...variables, environments: remaining })
    onActiveEnvironmentChange(remaining[0]?.id ?? null)
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="variables-dialog">
      <DialogHeader><DialogTitle>Manage variables</DialogTitle><DialogDescription>Use <code>{'{{variableName}}'}</code> in request URLs, params, headers, auth, or body.</DialogDescription></DialogHeader>
      <p className="variable-policy">Regular values are shared in workspace commits. Mark credentials as Secret to keep their values on this device and out of cloud sync.</p>
      {!secureStorageAvailable && <p className="variable-storage-warning" role="status">Secure storage is unavailable. Secret values will last only until the app closes.</p>}
      <Tabs value={scope} onValueChange={setScope} className="variables-tabs">
        <TabsList aria-label="Variable scope"><TabsTrigger value="global">Global</TabsTrigger><TabsTrigger value="environment">Environments</TabsTrigger></TabsList>
        <TabsContent value="global" className="variables-pane">
          <p className="variable-scope-help">Global variables are available throughout this workspace. The active environment overrides a global variable with the same name.</p>
          <VariableRows rows={variables.globals} readOnly={readOnly} onChange={updateGlobalRows} />
        </TabsContent>
        <TabsContent value="environment" className="variables-pane">
          <section className="environment-list-section" aria-label="Environment list">
            <div className="environment-section-heading">
              <div><strong>Environment list</strong><span>Choose one to edit. Requests use the active environment.</span></div>
              <span className="environment-total">{variables.environments.length} / 100</span>
            </div>
            <div className="environment-list" role="group" aria-label="Choose active environment">
              <button type="button" className={cn('environment-list-item', !selectedEnvironment && 'environment-list-item-active')} aria-pressed={!selectedEnvironment} onClick={() => onActiveEnvironmentChange(null)}>
                <span className="environment-item-icon" aria-hidden="true">◎</span>
                <span className="environment-item-copy"><strong>No active environment</strong><small>Requests use Global variables only</small></span>
                {!selectedEnvironment && <span className="environment-active-badge">Active</span>}
              </button>
              {variables.environments.map((environment) => <button type="button" key={environment.id} className={cn('environment-list-item', selectedEnvironment?.id === environment.id && 'environment-list-item-active')} aria-pressed={selectedEnvironment?.id === environment.id} onClick={() => onActiveEnvironmentChange(environment.id)}>
                <span className="environment-item-icon" aria-hidden="true">◉</span>
                <span className="environment-item-copy"><strong>{environment.name}</strong><small>{environment.variables.length} variable{environment.variables.length === 1 ? '' : 's'}</small></span>
                {selectedEnvironment?.id === environment.id && <span className="environment-active-badge">Active</span>}
              </button>)}
            </div>
          </section>
          <div className="environment-create-panel">
            <div className="environment-create-copy"><strong>Add environment</strong><span>Create a separate set of values, such as Development or Staging.</span></div>
            <form className="environment-create-form" onSubmit={createEnvironment}>
              <Input aria-label="New environment name" maxLength={100} value={environmentNameDraft} readOnly={readOnly} onChange={(event) => setEnvironmentNameDraft(event.target.value)} placeholder="e.g. Development" />
              <Button type="submit" size="sm" disabled={readOnly || variables.environments.length >= 100 || !environmentNameDraft.trim()}>Add environment</Button>
            </form>
          </div>
          {selectedEnvironment ? <>
            <div className="environment-name-row"><label><span>Editing environment</span><Input aria-label="Environment name" maxLength={100} value={selectedEnvironment.name} readOnly={readOnly} onChange={(event) => updateEnvironment({ name: event.target.value })} /></label><Button type="button" variant="ghost" size="sm" disabled={readOnly} onClick={deleteEnvironment}>Delete environment</Button></div>
            <p className="variable-scope-help">Values in this environment replace matching Global values when it is active.</p>
            <VariableRows rows={selectedEnvironment.variables} readOnly={readOnly} onChange={(rows) => updateEnvironment({ variables: rows })} />
          </> : <p className="variable-empty environment-empty">{variables.environments.length ? 'Select an environment above to view and edit its variables.' : 'No environments yet. Add one above to create your first set of environment variables.'}</p>}
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>
}

function VariableQuickEditDialog({ target, variables, activeEnvironmentId, resolvedValues, readOnly, onClose, onSave }: {
  target: { name: string; sourceValue: string } | null
  variables: WorkspaceVariables
  activeEnvironmentId: string | null
  resolvedValues: Record<string, string>
  readOnly: boolean
  onClose: () => void
  onSave: (name: string, scopeId: string, value: string) => void
}) {
  const activeEnvironment = variables.environments.find((environment) => environment.id === activeEnvironmentId)
  const [scopeId, setScopeId] = useState('global')
  const [draft, setDraft] = useState('')

  const findVariable = (name: string, scope: string) => scope === 'global'
    ? variables.globals.find((variable) => variable.name.trim() === name)
    : variables.environments.find((environment) => environment.id === scope)?.variables.find((variable) => variable.name.trim() === name)

  useEffect(() => {
    if (!target) return
    const environmentVariable = activeEnvironment?.variables.find((variable) => variable.name.trim() === target.name)
    const globalVariable = variables.globals.find((variable) => variable.name.trim() === target.name)
    const selected = environmentVariable ?? globalVariable
    const nextScope = environmentVariable && activeEnvironment
      ? activeEnvironment.id
      : globalVariable
        ? 'global'
        : activeEnvironment?.id ?? 'global'
    setScopeId(nextScope)
    setDraft(selected?.value ?? '')
  }, [target?.name, activeEnvironmentId])

  const selectedVariable = target ? findVariable(target.name, scopeId) : undefined
  const canEdit = !readOnly || selectedVariable?.secret === true
  const referencedNames = target ? [...target.sourceValue.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim()) : []
  const secretNames = new Set([...variables.globals, ...(activeEnvironment?.variables ?? [])].filter((variable) => variable.secret).map((variable) => variable.name.trim()))
  const previewHasSecret = referencedNames.some((name) => secretNames.has(name))
  const previewValues = { ...resolvedValues }
  if (target && !(scopeId === 'global' && activeEnvironment?.variables.some((variable) => variable.name.trim() === target.name))) previewValues[target.name] = draft
  const preview = target?.sourceValue.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, rawName: string) => previewValues[rawName.trim()] ?? token) ?? ''

  function changeScope(nextScope: string) {
    setScopeId(nextScope)
    setDraft(target ? findVariable(target.name, nextScope)?.value ?? '' : '')
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!target || !canEdit) return
    onSave(target.name, scopeId, draft)
  }

  return <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="variable-quick-dialog">
      <DialogHeader>
        <span className="variable-editor-eyebrow">Workspace variable</span>
        <DialogTitle>{target?.name ?? 'Edit variable'}</DialogTitle>
        <DialogDescription>Change a saved value here. The request keeps using the same <code>{`{{${target?.name ?? 'name'}}}`}</code> reference.</DialogDescription>
      </DialogHeader>
      <form className="variable-quick-form" onSubmit={submit}>
        <div className="variable-quick-reference"><span>Reference</span><code>{target ? `{{${target.name}}}` : ''}</code></div>
        <label className="variable-quick-label"><span>Scope</span>
          <Select value={scopeId} onValueChange={changeScope}>
            <SelectTrigger aria-label="Variable scope"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Global</SelectItem>
              {activeEnvironment && <SelectItem value={activeEnvironment.id}>{activeEnvironment.name}</SelectItem>}
            </SelectContent>
          </Select>
        </label>
        <label className="variable-quick-label"><span>Value{selectedVariable?.secret && <span className="variable-secret-badge">Secret · this device</span>}</span>
          <Input autoFocus aria-label={`Value for ${target?.name ?? 'variable'}`} type={selectedVariable?.secret ? 'password' : 'text'} autoComplete="off" value={draft} readOnly={!canEdit} onChange={(event) => setDraft(event.target.value)} placeholder={readOnly ? 'No local secret value saved' : 'Enter a value'} />
        </label>
        {!selectedVariable && <p className="variable-create-note">Saving creates this variable in {scopeId === 'global' ? 'Global' : activeEnvironment?.name ?? 'the active environment'}.</p>}
        <div className="variable-quick-preview"><span>In this field</span><code>{previewHasSecret ? 'Preview hidden because this reference uses a secret value.' : preview || 'Nothing to preview'}</code></div>
        {readOnly && !selectedVariable?.secret && <p className="variable-create-note">This workspace is read only. Secret values can still be saved on this device.</p>}
        <div className="variable-quick-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!canEdit}>Save value</Button></div>
      </form>
    </DialogContent>
  </Dialog>
}

function OpenApiDialog({ open, onOpenChange, tree, workspaceName, readOnly, onImport }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tree: TreeNode[]
  workspaceName: string
  readOnly: boolean
  onImport: (tree: TreeNode[]) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<{ tree: TreeNode[]; title: string; fileName: string; requestCount: number } | null>(null)
  const [error, setError] = useState('')
  const requestCount = (nodes: TreeNode[]): number => nodes.reduce((count, node) => count + (node.kind === 'folder' ? requestCount(node.children) : 1), 0)

  useEffect(() => {
    if (open) return
    setPreview(null)
    setError('')
  }, [open])

  async function readFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setError('')
    try {
      const imported = importOpenApi(await file.text())
      setPreview({ ...imported, fileName: file.name })
    } catch (reason) {
      setPreview(null)
      setError(reason instanceof Error ? reason.message : 'Could not read this OpenAPI file.')
    }
  }

  function exportFile(format: 'json' | 'yaml') {
    try {
      const content = serializeOpenApi(tree, workspaceName, format)
      const slug = workspaceName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'
      const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'application/yaml' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${slug}.openapi.${format}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not export this workspace.')
    }
  }

  function applyImport() {
    if (!preview || readOnly) return
    onImport(preview.tree)
    setPreview(null)
    onOpenChange(false)
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="openapi-dialog">
      <DialogHeader>
        <DialogTitle>OpenAPI</DialogTitle>
        <DialogDescription>Import an OpenAPI 3.0 or 3.1 file into this workspace, or export its current requests. Imports are added to the workspace.</DialogDescription>
      </DialogHeader>
      <input ref={fileInputRef} className="sr-only" type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" onChange={(event) => void readFile(event)} />
      <div className="openapi-actions">
        <Button type="button" variant="outline" disabled={readOnly} onClick={() => fileInputRef.current?.click()}>Choose OpenAPI file</Button>
        <Button type="button" variant="outline" onClick={() => exportFile('json')}>Export JSON</Button>
        <Button type="button" variant="outline" onClick={() => exportFile('yaml')}>Export YAML</Button>
      </div>
      {preview && <div className="openapi-preview" role="status">
        <div><strong>{preview.title}</strong><span>{preview.fileName}</span></div>
        <p>{preview.requestCount} request{preview.requestCount === 1 ? '' : 's'} found. They will be added to {workspaceName}.</p>
        <Button type="button" disabled={readOnly} onClick={applyImport}>Add requests</Button>
      </div>}
      {error && <p className="openapi-error" role="alert">{error}</p>}
      {readOnly && <p className="openapi-read-only">This workspace is read only. You can still export its requests.</p>}
    </DialogContent>
  </Dialog>
}

function App() {
  const [collectionWidth, setCollectionWidth] = useState(readCollectionWidth)
  const collectionWidthRef = useRef(collectionWidth)
  const pendingCollectionWidthRef = useRef(collectionWidth)
  const collectionResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const appShellRef = useRef<HTMLElement>(null)
  const [tree, setTree] = useState<TreeNode[]>(initialTree)
  const [workspaceVariables, setWorkspaceVariables] = useState<WorkspaceVariables>(emptyWorkspaceVariables())
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(null)
  const [variablesDialogOpen, setVariablesDialogOpen] = useState(false)
  const [openApiDialogOpen, setOpenApiDialogOpen] = useState(false)
  const [quickEditTarget, setQuickEditTarget] = useState<{ name: string; sourceValue: string } | null>(null)
  const [secureStorageAvailable, setSecureStorageAvailable] = useState(true)
  const [localWorkspaces, setLocalWorkspaces] = useState<LocalWorkspace[]>([])
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState('')
  const [storageLoaded, setStorageLoaded] = useState(false)
  const pendingWorkspaceSaveRef = useRef<LocalWorkspace | null>(null)
  const workspaceSaveTimerRef = useRef<number | undefined>(undefined)
  const [selectedRequestId, setSelectedRequestId] = useState(() => firstRequestId(readTree()))
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>(() => {
    const requestId = firstRequestId(readTree())
    return requestId ? [{ kind: 'request', id: requestId }] : []
  })
  const [activeWorkspaceTabKey, setActiveWorkspaceTabKey] = useState(() => {
    const requestId = firstRequestId(readTree())
    return requestId ? `request:${requestId}` : ''
  })
  const [selectedFolderId, setSelectedFolderId] = useState(() => readTree()[0]?.id ?? '')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(readTree().filter(isFolder).map((folder) => folder.id)))
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [response, setResponse] = useState<ResponseState>({ kind: 'empty' })
  const [responseView, setResponseView] = useState<'body' | 'headers' | 'cookies'>('body')
  const [sendMenuOpen, setSendMenuOpen] = useState(false)
  const [downloadAfterSend, setDownloadAfterSend] = useState(false)
  const [sendDelayDialogOpen, setSendDelayDialogOpen] = useState(false)
  const [sendDelaySeconds, setSendDelaySeconds] = useState('1')
  const [sendNotice, setSendNotice] = useState('')
  const [repeatDialogOpen, setRepeatDialogOpen] = useState(false)
  const [repeatIntervalSeconds, setRepeatIntervalSeconds] = useState('5')
  const [repeatRunning, setRepeatRunning] = useState(false)
  const [clientCodeDialogOpen, setClientCodeDialogOpen] = useState(false)
  const [clientCode, setClientCode] = useState('')
  const [clientCodeStatus, setClientCodeStatus] = useState('')
  const sendOptionsButtonRef = useRef<HTMLButtonElement>(null)
  const sendDelayTimerRef = useRef<number | undefined>(undefined)
  const repeatTimerRef = useRef<number | undefined>(undefined)
  const repeatRunIdRef = useRef(0)
  const [newFolderName, setNewFolderName] = useState('')
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [newFolderParentId, setNewFolderParentId] = useState('')
  const [contextMenu, setContextMenu] = useState<CollectionContextMenu | null>(null)
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<DeleteConfirmTarget | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState('')
  const [folderNameDraft, setFolderNameDraft] = useState('')
  const cancelRenameOnBlur = useRef(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const sessionTokenRef = useRef<string | null>(null)
  const [user, setUser] = useState<ApiUser | null>(null)
  const [authOpenRequest, setAuthOpenRequest] = useState(0)
  const [authError, setAuthError] = useState('')
  const [cloudWorkspaces, setCloudWorkspaces] = useState<CloudWorkspace[]>([])
  const cloudHistoryWorkspaceIdRef = useRef('')
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [cloudWorkspaceName, setCloudWorkspaceName] = useState('')
  const [teamDialogOpen, setTeamDialogOpen] = useState(false)
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor')
  const [inviteEmailDraft, setInviteEmailDraft] = useState('')
  const [inviteLink, setInviteLink] = useState('')
  const [inviteTokenDraft, setInviteTokenDraft] = useState('')
  const [inviteError, setInviteError] = useState('')
  const [inviteNotice, setInviteNotice] = useState('')
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitDialogView, setCommitDialogView] = useState<'changes' | 'history'>('changes')
  const [syncMenuOpen, setSyncMenuOpen] = useState(false)
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [selectedChangeId, setSelectedChangeId] = useState('')
  const [selectedHistoryCommitId, setSelectedHistoryCommitId] = useState('')
  const [selectedHistoryChangeId, setSelectedHistoryChangeId] = useState('')
  const [localCommits, setLocalCommits] = useState<LocalCommit[]>([])
  const [cloudCommits, setCloudCommits] = useState<CloudCommit[]>([])
  const [cloudCommitDetails, setCloudCommitDetails] = useState<Record<string, CloudCommitDetail>>({})
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyDetailError, setHistoryDetailError] = useState('')
  const [stagedSnapshot, setStagedSnapshot] = useState<TreeNode[] | null>(null)
  const [stagedVariables, setStagedVariables] = useState<WorkspaceVariables | null>(null)
  const stagedWorkspaceIdRef = useRef('')
  const [syncStatus, setSyncStatus] = useState('')
  const [pendingMerge, setPendingMerge] = useState<PendingMerge | null>(null)
  const [mergeChoices, setMergeChoices] = useState<Record<string, 'local' | 'remote'>>({})
  const treeIndex = useMemo(() => indexTree(tree), [tree])
  function commitCollectionWidth(width: number) {
    const nextWidth = clampCollectionWidth(width)
    collectionWidthRef.current = nextWidth
    pendingCollectionWidthRef.current = nextWidth
    appShellRef.current?.style.setProperty('--sidebar-width', `${nextWidth}px`)
    setCollectionWidth(nextWidth)
    try { localStorage.setItem(collectionWidthStorageKey, String(nextWidth)) } catch { /* The panel still resizes for this session. */ }
  }
  function startCollectionResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    collectionResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: collectionWidthRef.current }
    pendingCollectionWidthRef.current = collectionWidthRef.current
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing-collection')
  }
  function moveCollectionResize(event: React.PointerEvent<HTMLDivElement>) {
    const resize = collectionResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const nextWidth = clampCollectionWidth(resize.startWidth + event.clientX - resize.startX)
    pendingCollectionWidthRef.current = nextWidth
    appShellRef.current?.style.setProperty('--sidebar-width', `${nextWidth}px`)
  }
  function finishCollectionResize(event: React.PointerEvent<HTMLDivElement>) {
    if (collectionResizeRef.current?.pointerId !== event.pointerId) return
    collectionResizeRef.current = null
    document.body.classList.remove('is-resizing-collection')
    commitCollectionWidth(pendingCollectionWidthRef.current)
  }
  function handleCollectionResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const increment = event.shiftKey ? 48 : 16
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const nextWidth = event.key === 'Home' ? minCollectionWidth
        : event.key === 'End' ? collectionWidthLimit()
          : collectionWidthRef.current + (event.key === 'ArrowRight' ? increment : -increment)
      commitCollectionWidth(nextWidth)
    }
  }
  useEffect(() => {
    const constrainCollectionWidth = () => {
      const nextWidth = clampCollectionWidth(collectionWidthRef.current)
      if (nextWidth !== collectionWidthRef.current) commitCollectionWidth(nextWidth)
    }
    window.addEventListener('resize', constrainCollectionWidth)
    return () => window.removeEventListener('resize', constrainCollectionWidth)
  }, [])
  useEffect(() => () => {
    if (sendDelayTimerRef.current !== undefined) window.clearTimeout(sendDelayTimerRef.current)
    if (repeatTimerRef.current !== undefined) window.clearTimeout(repeatTimerRef.current)
    repeatRunIdRef.current += 1
  }, [])
  useEffect(() => {
    let active = true
    const legacyTree = readTree()
    void window.apiDesktop.secureStorageAvailable().then((available) => { if (active) setSecureStorageAvailable(available) }).catch(() => { if (active) setSecureStorageAvailable(false) })
    void window.apiDesktop.loadWorkspace(legacyTree).then(async (defaultWorkspace) => {
      const storedRecords = await window.apiDesktop.listWorkspaces()
      if (!active) return
      const records = storedRecords.map((item) => ({
        ...item,
        tree: normalizeTree(item.tree),
        baseTree: normalizeTree(item.baseTree),
        variables: normalizeWorkspaceVariables(item.variables),
        baseVariables: normalizeSharedVariables(item.baseVariables ?? item.variables),
        activeEnvironmentId: item.activeEnvironmentId ?? null
      }))
      const current = records.find((item) => item.id === defaultWorkspace.id) ?? {
        ...defaultWorkspace,
        tree: normalizeTree(defaultWorkspace.tree),
        baseTree: normalizeTree(defaultWorkspace.baseTree),
        variables: normalizeWorkspaceVariables(defaultWorkspace.variables),
        baseVariables: normalizeSharedVariables(defaultWorkspace.baseVariables ?? defaultWorkspace.variables),
        activeEnvironmentId: defaultWorkspace.activeEnvironmentId ?? null
      }
      setLocalWorkspaces(records.length ? records : [current])
      setCurrentWorkspaceId(current.id)
      stagedWorkspaceIdRef.current = current.id
      setStagedSnapshot(readStagedSnapshot(current.id))
      setStagedVariables(readStagedVariables(current.id))
      const normalizedTree = normalizeTree(current.tree)
      setTree(normalizedTree)
      const normalizedVariables = normalizeWorkspaceVariables(current.variables)
      setWorkspaceVariables(normalizedVariables)
      const savedEnvironmentId = current.activeEnvironmentId && normalizedVariables.environments.some((environment) => environment.id === current.activeEnvironmentId) ? current.activeEnvironmentId : null
      setActiveEnvironmentId(savedEnvironmentId)
      restoreTabs(current.id, normalizedTree, normalizedVariables)
      setExpandedFolders(new Set(normalizedTree.filter(isFolder).map((folder) => folder.id)))
      localStorage.removeItem('api-docs-workspace')
      localStorage.removeItem('api-docs-collections')
      setStorageLoaded(true)
    }).catch((error) => setAuthError(error instanceof Error ? error.message : 'Could not load local workspace.'))
    void window.apiDesktop.loadSession().then(async (token) => {
      if (!token || !active) return
      try {
        const result = await apiCall<{ user: ApiUser }>('/api/me', { token })
        if (!active) return
        setSessionToken(token)
        setUser(result.user)
      } catch { await window.apiDesktop.clearSession() }
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => window.apiDesktop.onExternalWorkspaceChange(() => {
    void window.apiDesktop.listWorkspaces().then((storedRecords) => {
      const records = storedRecords.map((item) => ({
        ...item,
        tree: normalizeTree(item.tree),
        baseTree: normalizeTree(item.baseTree),
        variables: normalizeWorkspaceVariables(item.variables),
        baseVariables: normalizeSharedVariables(item.baseVariables ?? item.variables),
        activeEnvironmentId: item.activeEnvironmentId ?? null
      }))
      setLocalWorkspaces(records)
      const current = records.find((item) => item.id === currentWorkspaceId)
      if (!current) return
      setTree(current.tree)
      setWorkspaceVariables(current.variables ?? emptyWorkspaceVariables())
      setActiveEnvironmentId(current.activeEnvironmentId)
    }).catch((error) => setSyncStatus(error instanceof Error ? error.message : 'Could not refresh workspace changes.'))
  }), [currentWorkspaceId])

  useEffect(() => {
    if (!sessionToken || !user || !storageLoaded) return
    let active = true
    void apiCall<{ workspaces: CloudWorkspace[] }>('/api/workspaces', { token: sessionToken }).then(async ({ workspaces }) => {
      const records: LocalWorkspace[] = []
      for (const cloud of workspaces) {
        if (!active) return
        const existing = localWorkspaces.find((item) => item.cloudId === cloud.id)
        if (existing) {
          records.push({ ...existing, name: cloud.name, role: cloud.role })
        } else {
          const result = await apiCall<{ workspace: CloudWorkspace & { tree: TreeNode[]; variables?: WorkspaceVariables } }>(`/api/workspaces/${cloud.id}/sync/pull`, { token: sessionToken })
          const remoteTree = normalizeSharedTree(result.workspace.tree)
          const remoteVariables = normalizeSharedVariables(result.workspace.variables)
          records.push({ id: crypto.randomUUID(), cloudId: cloud.id, name: cloud.name, tree: remoteTree, baseTree: remoteTree, variables: remoteVariables, baseVariables: remoteVariables, activeEnvironmentId: remoteVariables.environments[0]?.id ?? null, baseCommitId: result.workspace.headCommitId, localHeadId: result.workspace.headCommitId, role: cloud.role })
        }
      }
      if (!active) return
      setCloudWorkspaces(workspaces)
      if (records.length) {
        await Promise.all(records.map((record) => window.apiDesktop.saveWorkspace(record)))
        setLocalWorkspaces((current) => {
          const localOnly = current.filter((item) => !item.cloudId)
          return [...localOnly, ...records]
        })
      }
    }).catch((error) => { if (active) setSyncStatus(error instanceof Error ? error.message : 'Could not load cloud workspaces.') })
    return () => { active = false }
  }, [sessionToken, user, storageLoaded])

  useEffect(() => {
    if (!storageLoaded || !currentWorkspaceId) return
    const current = localWorkspaces.find((item) => item.id === currentWorkspaceId)
    if (!current) return
    const pending = pendingWorkspaceSaveRef.current
    if (workspaceSaveTimerRef.current !== undefined) window.clearTimeout(workspaceSaveTimerRef.current)
    if (pending && pending.id !== currentWorkspaceId) void window.apiDesktop.saveWorkspace(pending)
    pendingWorkspaceSaveRef.current = { ...current, tree: tree as unknown[], variables: workspaceVariables, activeEnvironmentId }
    workspaceSaveTimerRef.current = window.setTimeout(() => {
      const latest = pendingWorkspaceSaveRef.current
      pendingWorkspaceSaveRef.current = null
      workspaceSaveTimerRef.current = undefined
      if (latest) void window.apiDesktop.saveWorkspace(latest)
    }, 350)
  }, [tree, workspaceVariables, activeEnvironmentId, localWorkspaces, currentWorkspaceId, storageLoaded])

  useEffect(() => () => {
    if (workspaceSaveTimerRef.current !== undefined) window.clearTimeout(workspaceSaveTimerRef.current)
    if (pendingWorkspaceSaveRef.current) void window.apiDesktop.saveWorkspace(pendingWorkspaceSaveRef.current)
  }, [])

  useEffect(() => {
    if (!storageLoaded || !currentWorkspaceId) return
    localStorage.setItem(`api-docs-open-tabs-${currentWorkspaceId}`, JSON.stringify({ tabs: workspaceTabs, activeKey: activeWorkspaceTabKey }))
  }, [workspaceTabs, activeWorkspaceTabKey, currentWorkspaceId, storageLoaded])

  useEffect(() => {
    const next = workspaceTabs.filter((tab) => tab.kind === 'environment'
      ? workspaceVariables.environments.some((environment) => environment.id === tab.id)
      : treeIndex.nodeById.get(tab.id)?.kind === 'request')
    if (next.length === workspaceTabs.length) return
    setWorkspaceTabs(next)
    if (!next.some((tab) => workspaceTabKey(tab) === activeWorkspaceTabKey)) {
      const fallback = next.at(-1)
      setActiveWorkspaceTabKey(fallback ? workspaceTabKey(fallback) : '')
      if (fallback?.kind === 'request') {
        setSelectedRequestId(fallback.id)
        setSelectedFolderId(treeIndex.parentFolderById.get(fallback.id) ?? '')
      } else if (fallback?.kind === 'docs') {
        setSelectedRequestId(fallback.id)
        setSelectedFolderId(treeIndex.parentFolderById.get(fallback.id) ?? '')
      } else if (fallback?.kind === 'environment') setActiveEnvironmentId(fallback.id)
    }
  }, [treeIndex, workspaceVariables, workspaceTabs])

  useEffect(() => {
    if (!currentWorkspaceId) { setLocalCommits([]); return }
    let active = true
    void window.apiDesktop.listCommits(currentWorkspaceId).then((commits) => {
      if (active) setLocalCommits(commits as LocalCommit[])
    }).catch(() => { if (active) setLocalCommits([]) })
    return () => { active = false }
  }, [currentWorkspaceId])

  useEffect(() => {
    if (!currentWorkspaceId || stagedWorkspaceIdRef.current !== currentWorkspaceId) return
    const key = `api-docs-staged-${currentWorkspaceId}`
    if (stagedSnapshot) localStorage.setItem(key, JSON.stringify(stagedSnapshot))
    else localStorage.removeItem(key)
  }, [stagedSnapshot, currentWorkspaceId])

  useEffect(() => {
    if (!currentWorkspaceId || stagedWorkspaceIdRef.current !== currentWorkspaceId) return
    const key = `api-docs-staged-variables-${currentWorkspaceId}`
    if (stagedVariables) localStorage.setItem(key, JSON.stringify(shareableWorkspaceVariables(stagedVariables)))
    else localStorage.removeItem(key)
  }, [stagedVariables, currentWorkspaceId])

  const activeRequest = treeIndex.nodeById.get(selectedRequestId)
  const activeRequestRef = useRef<SavedRequest | undefined>(undefined)
  useLayoutEffect(() => {
    activeRequestRef.current = activeRequest && isRequest(activeRequest) ? activeRequest : undefined
  }, [activeRequest])
  const activeFolder = treeIndex.nodeById.get(selectedFolderId)
  const activeWorkspaceTab = workspaceTabs.find((tab) => workspaceTabKey(tab) === activeWorkspaceTabKey)
  const activeDocsRequest = activeWorkspaceTab?.kind === 'docs' ? treeIndex.nodeById.get(activeWorkspaceTab.id) : undefined
  const activeEnvironmentTab = activeWorkspaceTab?.kind === 'environment'
    ? workspaceVariables.environments.find((environment) => environment.id === activeWorkspaceTab.id)
    : undefined
  const requestTabIndicators = activeRequest && isRequest(activeRequest) ? {
    activeParams: (activeRequest.params ?? []).filter((param) => param.enabled && param.name.trim()).length,
    hasBody: (activeRequest.bodyMode ?? (activeRequest.body.trim() ? 'json' : 'none')) !== 'none',
    hasAuth: (activeRequest.auth ?? { type: 'none' }).type !== 'none',
    headers: requestHeaderCount(activeRequest)
  } : null
  const activeWorkspace = localWorkspaces.find((item) => item.id === currentWorkspaceId)
  const isReadOnly = activeWorkspace?.role === 'viewer'
  useEffect(() => {
    if (!sessionToken || !cloudWorkspaces.length) return
    let active = true
    const refreshCloudHeads = async () => {
      try {
        const result = await apiCall<{ workspaces: CloudWorkspace[] }>('/api/workspaces', { token: sessionToken })
        if (active) setCloudWorkspaces(result.workspaces)
      } catch {
        // Keep the last known cloud status when the network is temporarily unavailable.
      }
    }
    void refreshCloudHeads()
    const timer = window.setInterval(() => void refreshCloudHeads(), 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [sessionToken, cloudWorkspaces.length])
  useEffect(() => {
    if (!sessionToken) return
    let active = true
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let reconnectAttempt = 0

    const scheduleReconnect = () => {
      if (!active || reconnectTimer !== undefined) return
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5))
      reconnectAttempt += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        void connect()
      }, delay)
    }

    const connect = async () => {
      try {
        const { ticket } = await apiCall<{ ticket: string }>('/api/sync/events-ticket', { token: sessionToken, method: 'POST' })
        if (!active) return
        const endpoint = new URL(apiWebSocketUrl('/api/sync/events'))
        endpoint.searchParams.set('ticket', ticket)
        const connection = new WebSocket(endpoint.toString())
        socket = connection
        connection.addEventListener('open', () => {
          reconnectAttempt = 0
          void refreshCloudHeads()
        }, { once: true })
        connection.addEventListener('message', (messageEvent) => {
          try {
            const update = JSON.parse(String(messageEvent.data)) as WorkspaceUpdateEvent
            if (update.type !== 'workspace.updated' || typeof update.workspaceId !== 'string' || typeof update.headCommitId !== 'string') return
            setCloudWorkspaces((current) => current.map((workspace) => workspace.id === update.workspaceId
              ? { ...workspace, headCommitId: update.headCommitId }
              : workspace))
            const count = update.commitCount === 1 ? '1 commit' : `${update.commitCount} commits`
            const actor = typeof update.actorEmail === 'string' ? update.actorEmail : 'A teammate'
            const message = typeof update.message === 'string' ? `: “${update.message}”` : ''
            setSyncStatus(`${actor} pushed ${count}${message}. Pull to get updates.`)
          } catch {
            // Ignore malformed messages and keep the sync connection available.
          }
        })
        connection.addEventListener('close', scheduleReconnect, { once: true })
        connection.addEventListener('error', () => connection.close(), { once: true })
      } catch {
        scheduleReconnect()
      }
    }

    const refreshCloudHeads = async () => {
      try {
        const result = await apiCall<{ workspaces: CloudWorkspace[] }>('/api/workspaces', { token: sessionToken })
        if (active) setCloudWorkspaces(result.workspaces)
      } catch {
        // The existing polling fallback will retry when the current workspace is cloud-backed.
      }
    }

    void connect()
    return () => {
      active = false
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      socket?.close(1000, 'Session ended')
    }
  }, [sessionToken])
  useEffect(() => {
    if (!commitDialogOpen || commitDialogView !== 'history') return
    if (!sessionToken || !activeWorkspace?.cloudId) {
      if (cloudHistoryWorkspaceIdRef.current) {
        setCloudCommits([])
        setCloudCommitDetails({})
      }
      cloudHistoryWorkspaceIdRef.current = ''
      setHistoryLoading(false)
      setHistoryError('')
      return
    }
    let active = true
    if (cloudHistoryWorkspaceIdRef.current !== activeWorkspace.cloudId) {
      cloudHistoryWorkspaceIdRef.current = activeWorkspace.cloudId
      setCloudCommits([])
      setCloudCommitDetails({})
    }
    setHistoryLoading(true)
    setHistoryError('')
    void apiCall<{ commits: CloudCommit[] }>(`/api/workspaces/${activeWorkspace.cloudId}/sync/history`, { token: sessionToken })
      .then((result) => { if (active) setCloudCommits(result.commits) })
      .catch((error) => { if (active) setHistoryError(error instanceof Error ? error.message : 'Could not load cloud history.') })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [commitDialogOpen, commitDialogView, sessionToken, activeWorkspace?.cloudId])
  const lastLocalCommit = localCommits.find((commit) => commit.id === activeWorkspace?.localHeadId)
  const committedTree = (lastLocalCommit?.tree ?? activeWorkspace?.baseTree ?? tree) as TreeNode[]
  const committedVariablesSource = lastLocalCommit?.variables ?? activeWorkspace?.baseVariables ?? activeWorkspace?.variables
  const committedVariables = useMemo(() => normalizeWorkspaceVariables(committedVariablesSource), [committedVariablesSource])
  const stageBaseTree = stagedSnapshot ?? committedTree
  const stageBaseVariables = stagedVariables ?? committedVariables
  const workspaceChanges = useMemo(() => getWorkspaceChanges(committedTree, tree, committedVariables, workspaceVariables), [committedTree, tree, committedVariables, workspaceVariables])
  const pendingPushCount = localCommits.filter((commit) => !commit.pushed).length
  const cloudHeadCommitId = cloudWorkspaces.find((workspace) => workspace.id === activeWorkspace?.cloudId)?.headCommitId
  const cloudUpdateAvailable = Boolean(activeWorkspace?.cloudId && cloudHeadCommitId && cloudHeadCommitId !== activeWorkspace.baseCommitId)
  const pushDisabledReason = !sessionToken
    ? 'Sign in to sync this workspace.'
    : isReadOnly
      ? 'Viewer access cannot push changes.'
      : !pendingPushCount
        ? activeWorkspace?.cloudId ? 'Commit local changes before pushing.' : 'Commit changes first; Push will publish this local workspace.'
        : ''
  const showChanges = commitDialogOpen && commitDialogView === 'changes'
  const hasStagedContent = Boolean(stagedSnapshot || stagedVariables)
  const stagedChanges = useMemo(() => showChanges && hasStagedContent ? getWorkspaceChanges(committedTree, stageBaseTree, committedVariables, stageBaseVariables) : [], [showChanges, hasStagedContent, committedTree, stageBaseTree, committedVariables, stageBaseVariables])
  const unstagedChanges = useMemo(() => {
    if (!showChanges) return []
    if (!hasStagedContent) return workspaceChanges
    return getWorkspaceChanges(stageBaseTree, tree, stageBaseVariables, workspaceVariables)
  }, [showChanges, hasStagedContent, workspaceChanges, stageBaseTree, tree, stageBaseVariables, workspaceVariables])
  const changeById = useMemo(() => new Map(workspaceChanges.map((change) => [change.id, change])), [workspaceChanges])
  const selectedChange = showChanges ? workspaceChanges.find((change) => change.id === selectedChangeId) : undefined
  const diffRows = useMemo(() => selectedChange ? diffText(
    selectedChange.id === workspaceVariablesChangeId ? workspaceVariablesDiffText(committedVariables) : nodeDiffText(findNode(committedTree, selectedChange.id)),
    selectedChange.id === workspaceVariablesChangeId ? workspaceVariablesDiffText(workspaceVariables) : nodeDiffText(treeIndex.nodeById.get(selectedChange.id))
  ) : [], [selectedChange, committedTree, treeIndex, committedVariables, workspaceVariables])
  const historyCommits = useMemo<WorkspaceHistoryCommit[]>(() => {
    const combined = new Map<string, WorkspaceHistoryCommit>()
    for (const commit of cloudCommits) combined.set(commit.id, {
      ...commit,
      pushed: true,
      source: 'cloud'
    })
    for (const commit of localCommits) {
      const cloudVersion = combined.get(commit.id)
      combined.set(commit.id, {
        ...commit,
        pushed: commit.pushed || Boolean(cloudVersion),
        source: cloudVersion ? 'cloud' : 'local'
      })
    }
    return [...combined.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  }, [cloudCommits, localCommits])
  const historyCommitById = useMemo(() => new Map(historyCommits.map((commit) => [commit.id, commit])), [historyCommits])
  const localCommitIds = useMemo(() => new Set(localCommits.map((commit) => commit.id)), [localCommits])
  const selectedHistoryCommit = historyCommitById.get(selectedHistoryCommitId)
  const historyParentId = selectedHistoryCommit?.parentIds.find((id) => historyCommitById.has(id))
  const historyParentCommit = historyParentId ? historyCommitById.get(historyParentId) : undefined
  const selectedHistoryTreeValue = selectedHistoryCommit?.tree ?? (selectedHistoryCommit ? cloudCommitDetails[selectedHistoryCommit.id]?.tree : undefined)
  const historyParentTreeValue = historyParentCommit?.tree ?? (historyParentId ? cloudCommitDetails[historyParentId]?.tree : undefined)
  const historySnapshotsReady = Boolean(selectedHistoryCommit && Array.isArray(selectedHistoryTreeValue) && (!historyParentId || Array.isArray(historyParentTreeValue) || historyDetailError))
  const historyAfterTree = useMemo(() => normalizeTree(selectedHistoryTreeValue), [selectedHistoryTreeValue])
  const historyBeforeTree = useMemo(() => {
    if (Array.isArray(historyParentTreeValue)) return normalizeTree(historyParentTreeValue)
    return selectedHistoryCommit && (selectedHistoryCommit.source === 'local' || selectedHistoryCommit.parentIds.length > 0)
      ? activeWorkspace?.baseTree as TreeNode[] ?? []
      : []
  }, [historyParentTreeValue, selectedHistoryCommit, activeWorkspace?.baseTree])
  const historyBeforeVariables = useMemo(() => historyParentCommit?.variables
    ? normalizeWorkspaceVariables(historyParentCommit.variables)
    : historyParentId && cloudCommitDetails[historyParentId]?.variables
      ? normalizeWorkspaceVariables(cloudCommitDetails[historyParentId].variables)
    : selectedHistoryCommit && (selectedHistoryCommit.source === 'local' || selectedHistoryCommit.parentIds.length > 0)
      ? normalizeWorkspaceVariables(activeWorkspace?.baseVariables ?? emptyWorkspaceVariables())
      : emptyWorkspaceVariables(), [historyParentCommit, historyParentId, cloudCommitDetails, selectedHistoryCommit, activeWorkspace?.baseVariables])
  const historyAfterVariables = useMemo(() => normalizeWorkspaceVariables(selectedHistoryCommit?.variables ?? (selectedHistoryCommit ? cloudCommitDetails[selectedHistoryCommit.id]?.variables : undefined)), [selectedHistoryCommit, cloudCommitDetails])
  const historyChanges = useMemo(() => selectedHistoryCommit && historySnapshotsReady ? getWorkspaceChanges(historyBeforeTree, historyAfterTree, historyBeforeVariables, historyAfterVariables) : [], [selectedHistoryCommit, historySnapshotsReady, historyBeforeTree, historyAfterTree, historyBeforeVariables, historyAfterVariables])
  const selectedHistoryChange = historyChanges.find((change) => change.id === selectedHistoryChangeId)
  const historyDiffRows = useMemo(() => selectedHistoryCommit && selectedHistoryChange ? diffText(
    selectedHistoryChange.id === workspaceVariablesChangeId ? workspaceVariablesDiffText(historyBeforeVariables) : nodeDiffText(findNode(historyBeforeTree, selectedHistoryChange.id)),
    selectedHistoryChange.id === workspaceVariablesChangeId ? workspaceVariablesDiffText(historyAfterVariables) : nodeDiffText(findNode(historyAfterTree, selectedHistoryChange.id))
  ) : [], [selectedHistoryCommit, selectedHistoryChange, historyBeforeTree, historyAfterTree, historyAfterVariables, historyBeforeVariables])
  useEffect(() => {
    if (!commitDialogOpen || commitDialogView !== 'history' || !selectedHistoryCommit) {
      setHistoryDetailLoading(false)
      return
    }
    const requiredIds = [selectedHistoryCommit.id, ...(historyParentId ? [historyParentId] : [])]
    const missingIds = requiredIds.filter((id) => !Array.isArray(historyCommitById.get(id)?.tree) && !Array.isArray(cloudCommitDetails[id]?.tree))
    if (!missingIds.length) {
      setHistoryDetailLoading(false)
      setHistoryDetailError('')
      return
    }
    if (!sessionToken || !activeWorkspace?.cloudId) {
      setHistoryDetailLoading(false)
      setHistoryDetailError('Sign in to load this cloud commit.')
      return
    }
    let active = true
    setHistoryDetailLoading(true)
    setHistoryDetailError('')
    void Promise.all(missingIds.map(async (id) => {
      const result = await apiCall<{ commit: CloudCommitDetail }>(`/api/workspaces/${activeWorkspace.cloudId}/sync/history/${id}`, { token: sessionToken })
      return result.commit
    }))
      .then((details) => {
        if (!active) return
        setCloudCommitDetails((current) => {
          const retained = Object.fromEntries(Object.entries(current).filter(([id]) => requiredIds.includes(id))) as Record<string, CloudCommitDetail>
          for (const detail of details) retained[detail.id] = detail
          return retained
        })
      })
      .catch((error) => { if (active) setHistoryDetailError(error instanceof Error ? error.message : 'Could not load the selected commit.') })
      .finally(() => { if (active) setHistoryDetailLoading(false) })
    return () => { active = false }
  }, [commitDialogOpen, commitDialogView, selectedHistoryCommit, historyParentId, historyCommitById, cloudCommitDetails, sessionToken, activeWorkspace?.cloudId])
  const resolvedVariables = useMemo(() => activeVariableValues(workspaceVariables, activeEnvironmentId), [workspaceVariables, activeEnvironmentId])
  const variableSuggestions = useMemo<VariableSuggestion[]>(() => {
    const environment = workspaceVariables.environments.find((item) => item.id === activeEnvironmentId)
    const seen = new Set<string>()
    const suggestions: VariableSuggestion[] = []
    for (const variable of [...(environment?.variables ?? []), ...workspaceVariables.globals]) {
      const name = variable.name.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      suggestions.push({
        name,
        scope: environment?.variables.includes(variable) ? environment.name : 'Global',
        value: variable.value,
        secret: variable.secret
      })
    }
    return suggestions
  }, [workspaceVariables, activeEnvironmentId])

  useEffect(() => { sessionTokenRef.current = sessionToken }, [sessionToken])

  useEffect(() => window.apiDesktop.onInviteToken((token) => {
    setInviteTokenDraft(token)
    if (sessionTokenRef.current) setTeamDialogOpen(true)
    else setAuthOpenRequest((current) => current + 1)
  }), [])
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault()
        setSendMenuOpen(false)
        if (activeWorkspaceTab?.kind === 'request' && response.kind !== 'loading') void executeRequest()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [activeRequest, activeWorkspaceTab, downloadAfterSend, response.kind])
  function updateActiveRequest(patch: Partial<SavedRequest>) {
    const request = activeRequestRef.current?.id === selectedRequestId
      ? activeRequestRef.current
      : treeIndex.nodeById.get(selectedRequestId)
    if (!request || !isRequest(request)) return
    let synchronizedPatch = patch
    if ('url' in patch && !('params' in patch) && typeof patch.url === 'string') {
      synchronizedPatch = { ...patch, params: syncUrlParams(patch.url, request.params ?? []) }
    } else if ('params' in patch && !('url' in patch)) {
      const params = patch.params ?? []
      synchronizedPatch = { ...patch, url: replaceUrlParams(request.url, params) }
    }
    activeRequestRef.current = { ...request, ...synchronizedPatch }
    setTree((current) => {
      return updateNode(current, selectedRequestId, synchronizedPatch)
    })
  }

  async function executeRequest(download = false, requestOverride?: SavedRequest) {
    const request = requestOverride ?? (activeRequestRef.current?.id === selectedRequestId ? activeRequestRef.current : activeRequest && isRequest(activeRequest) ? activeRequest : undefined)
    if (!request) return
    if (!request.url.trim()) { setResponse({ kind: 'error', message: 'Enter a request URL before sending.' }); return }
    setResponse({ kind: 'loading' })
    setResponseView('body')
    try {
      const resolvedRequest = resolveRequestVariables(request, resolvedVariables)
      const data = await window.apiDesktop.sendRequest(toApiRequest(resolvedRequest))
      setResponse({ kind: 'success', data })
      if (download || downloadAfterSend) downloadResponse(data, request.name)
    } catch (error) {
      setResponse({ kind: 'error', message: error instanceof Error ? error.message : 'The request could not be completed.' })
    }
  }

  const beginBrowserSignIn = useCallback(async () => {
    setAuthError('')
    const cloudUrl = (import.meta.env.VITE_CLOUD_URL || 'http://localhost:5174').replace(/\/+$/, '')
    await window.apiDesktop.beginBrowserSignIn(cloudUrl)
  }, [])
  useEffect(() => window.apiDesktop.onAuthCode((code) => {
    void (async () => {
      try {
        const result = await apiCall<{ token: string; user: ApiUser }>('/api/desktop-login/exchange', { method: 'POST', body: { code } })
        setSessionToken(result.token)
        setUser(result.user)
        const saved = await window.apiDesktop.saveSession(result.token)
        if (!saved) setSyncStatus('Session will last until the app closes because secure storage is unavailable on this system.')
        if (inviteTokenDraft) setTeamDialogOpen(true)
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : 'Could not complete sign-in.')
      }
    })()
  }), [inviteTokenDraft])
  const clearAuthError = useCallback(() => setAuthError(''), [])
  const [updateStatus, setUpdateStatus] = useState<{ state: 'available' | 'downloading' | 'downloaded'; version: string; percent?: number } | { state: 'error'; version: string; message: string } | null>(null)
  useEffect(() => window.apiDesktop.onUpdateStatus(setUpdateStatus), [])

  async function signOut() {
    if (sessionToken) await apiCall('/api/auth/logout', { token: sessionToken, method: 'POST' }).catch(() => undefined)
    await window.apiDesktop.clearSession()
    setSessionToken(null)
    setUser(null)
    setCloudWorkspaces([])
    setInviteLink('')
    setSyncStatus('Signed out. Local workspace data remains on this device.')
  }

  function activateWorkspace(workspaceId: string) {
    const next = localWorkspaces.find((item) => item.id === workspaceId)
    if (!next) return
    if (workspaceSaveTimerRef.current !== undefined) window.clearTimeout(workspaceSaveTimerRef.current)
    const pending = pendingWorkspaceSaveRef.current
    pendingWorkspaceSaveRef.current = null
    workspaceSaveTimerRef.current = undefined
    if (pending) void window.apiDesktop.saveWorkspace(pending)
    setLocalWorkspaces((current) => current.map((item) => item.id === currentWorkspaceId ? { ...item, tree: tree as unknown[], variables: workspaceVariables, activeEnvironmentId } : item))
    stagedWorkspaceIdRef.current = next.id
    setStagedSnapshot(readStagedSnapshot(next.id))
    setStagedVariables(readStagedVariables(next.id))
    setCurrentWorkspaceId(next.id)
    const nextTree = normalizeTree(next.tree)
    setTree(nextTree)
    const nextVariables = normalizeWorkspaceVariables(next.variables)
    setWorkspaceVariables(nextVariables)
    setActiveEnvironmentId(next.activeEnvironmentId && nextVariables.environments.some((environment) => environment.id === next.activeEnvironmentId) ? next.activeEnvironmentId : null)
    restoreTabs(next.id, nextTree, nextVariables)
    setExpandedFolders(new Set(nextTree.filter(isFolder).map((folder) => folder.id)))
    setResponse({ kind: 'empty' })
  }

  async function createCloudWorkspace(event: FormEvent) {
    event.preventDefault()
    if (!sessionToken || !cloudWorkspaceName.trim()) return
    setSyncStatus('Creating cloud workspace…')
    try {
      const sharedVariables = shareableWorkspaceVariables(workspaceVariables)
      const result = await apiCall<{ workspace: CloudWorkspace & { tree: TreeNode[]; variables?: WorkspaceVariables } }>('/api/workspaces', { token: sessionToken, method: 'POST', body: { name: cloudWorkspaceName.trim(), tree: stripLocalFilePaths(tree), variables: sharedVariables } })
      const createdTree = normalizeSharedTree(result.workspace.tree)
      const baseVariables = normalizeSharedVariables(result.workspace.variables ?? sharedVariables)
      const createdVariables = preserveLocalSecretValues(baseVariables, workspaceVariables)
      const workspace: LocalWorkspace = { id: crypto.randomUUID(), cloudId: result.workspace.id, name: result.workspace.name, tree: createdTree, baseTree: createdTree, variables: createdVariables, baseVariables, activeEnvironmentId, baseCommitId: result.workspace.headCommitId, localHeadId: result.workspace.headCommitId, role: 'owner' }
      await window.apiDesktop.saveWorkspace(workspace)
      setLocalWorkspaces((current) => [...current, workspace])
      setCloudWorkspaces((current) => [...current, result.workspace])
      setCloudWorkspaceName('')
      setCreateWorkspaceOpen(false)
      stagedWorkspaceIdRef.current = workspace.id
      setStagedSnapshot(null)
      setStagedVariables(null)
      setCurrentWorkspaceId(workspace.id)
      setWorkspaceVariables(createdVariables)
      setActiveEnvironmentId(activeEnvironmentId)
      resetTabs(workspace.tree as TreeNode[])
      setSyncStatus('Cloud workspace created.')
    } catch (error) { setSyncStatus(error instanceof Error ? error.message : 'Could not create cloud workspace.') }
  }

  async function createInvite() {
    if (!sessionToken || !activeWorkspace?.cloudId) return
    setInviteError('')
    setInviteNotice('')
    const email = inviteEmailDraft.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setInviteError('Enter a valid email address for the teammate.')
      return
    }
    try {
      const result = await apiCall<{ token: string; emailSent: boolean }>(`/api/workspaces/${activeWorkspace.cloudId}/invites`, { token: sessionToken, method: 'POST', body: { email, role: inviteRole } })
      setInviteLink(`api-docs://invite?token=${encodeURIComponent(result.token)}`)
      setInviteNotice(result.emailSent
        ? `Invitation sent to ${email}. It expires in 7 days.`
        : 'Invitation link created, but email could not be sent. Copy the link to share it manually.')
    } catch (error) { setInviteError(error instanceof Error ? error.message : 'Could not create invite.') }
  }

  async function acceptInvite(event: FormEvent) {
    event.preventDefault()
    if (!sessionToken) { setInviteError('Sign in before accepting an invite.'); return }
    const token = inviteTokenDraft.includes('token=') ? new URL(inviteTokenDraft).searchParams.get('token') : inviteTokenDraft.trim()
    if (!token) { setInviteError('Paste a valid invite link or token.'); return }
    setInviteError('')
    setInviteNotice('')
    try {
      const result = await apiCall<{ workspace: CloudWorkspace & { tree: TreeNode[]; variables?: WorkspaceVariables } }>('/api/invites/accept', { token: sessionToken, method: 'POST', body: { token } })
      const invitedTree = normalizeSharedTree(result.workspace.tree)
      const invitedVariables = normalizeSharedVariables(result.workspace.variables)
      const workspace: LocalWorkspace = { id: crypto.randomUUID(), cloudId: result.workspace.id, name: result.workspace.name, tree: invitedTree, baseTree: invitedTree, variables: invitedVariables, baseVariables: invitedVariables, activeEnvironmentId: invitedVariables.environments[0]?.id ?? null, baseCommitId: result.workspace.headCommitId, localHeadId: result.workspace.headCommitId, role: result.workspace.role }
      await window.apiDesktop.saveWorkspace(workspace)
      setLocalWorkspaces((current) => [...current, workspace])
      setCloudWorkspaces((current) => [...current, result.workspace])
      setInviteTokenDraft('')
      stagedWorkspaceIdRef.current = workspace.id
      setStagedSnapshot(null)
      setStagedVariables(null)
      setCurrentWorkspaceId(workspace.id)
      setTree(workspace.tree as TreeNode[])
      setWorkspaceVariables(invitedVariables)
      setActiveEnvironmentId(workspace.activeEnvironmentId ?? null)
      resetTabs(workspace.tree as TreeNode[])
      setInviteLink('')
      setInviteNotice('Invite accepted. Workspace added.')
    } catch (error) { setInviteError(error instanceof Error ? error.message : 'Could not accept invite.') }
  }

  function persistActiveWorkspace(patch: Partial<LocalWorkspace>) {
    if (!activeWorkspace) return
    const updated = {
      ...activeWorkspace,
      ...patch,
      tree: Object.hasOwn(patch, 'tree') ? patch.tree as unknown[] : tree as unknown[],
      variables: Object.hasOwn(patch, 'variables') ? patch.variables : workspaceVariables,
      activeEnvironmentId: Object.hasOwn(patch, 'activeEnvironmentId') ? patch.activeEnvironmentId : activeEnvironmentId
    }
    setLocalWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item))
    void window.apiDesktop.saveWorkspace(updated)
  }

  function updateWorkspaceVariables(next: WorkspaceVariables) {
    if (isReadOnly && JSON.stringify(shareableWorkspaceVariables(next)) !== JSON.stringify(shareableWorkspaceVariables(workspaceVariables))) return
    setWorkspaceVariables(next)
    persistActiveWorkspace({ variables: next })
  }

  function updateActiveEnvironment(environmentId: string | null) {
    setActiveEnvironmentId(environmentId)
    persistActiveWorkspace({ activeEnvironmentId: environmentId })
  }

  function openRequestTab(requestId: string) {
    const request = treeIndex.nodeById.get(requestId)
    if (!request || !isRequest(request)) return
    const tab: WorkspaceTab = { kind: 'request', id: requestId }
    if (workspaceTabKey(tab) === activeWorkspaceTabKey) return
    setWorkspaceTabs((current) => current.some((item) => workspaceTabKey(item) === workspaceTabKey(tab)) ? current : [...current, tab])
    setActiveWorkspaceTabKey(workspaceTabKey(tab))
    setSelectedRequestId(requestId)
    setSelectedFolderId(treeIndex.parentFolderById.get(requestId) ?? '')
    setResponse({ kind: 'empty' })
  }

  function openDocsTab(requestId: string) {
    const request = treeIndex.nodeById.get(requestId)
    if (!request || !isRequest(request)) return
    const tab: WorkspaceTab = { kind: 'docs', id: requestId }
    setWorkspaceTabs((current) => current.some((item) => workspaceTabKey(item) === workspaceTabKey(tab)) ? current : [...current, tab])
    setActiveWorkspaceTabKey(workspaceTabKey(tab))
    setSelectedRequestId(requestId)
    setSelectedFolderId(treeIndex.parentFolderById.get(requestId) ?? '')
  }

  function openCurrentDocs() {
    const selected = activeRequest && isRequest(activeRequest) ? activeRequest : treeIndex.nodeById.get(firstRequestId(tree))
    if (selected && isRequest(selected)) openDocsTab(selected.id)
  }

  function openEnvironmentTab(environmentId: string) {
    const tab: WorkspaceTab = { kind: 'environment', id: environmentId }
    setWorkspaceTabs((current) => current.some((item) => workspaceTabKey(item) === workspaceTabKey(tab)) ? current : [...current, tab])
    setActiveWorkspaceTabKey(workspaceTabKey(tab))
    setActiveEnvironmentId(environmentId)
  }

  function selectWorkspaceTab(tab: WorkspaceTab) {
    if (workspaceTabKey(tab) === activeWorkspaceTabKey) return
    setActiveWorkspaceTabKey(workspaceTabKey(tab))
    if (tab.kind === 'request' || tab.kind === 'docs') {
      setSelectedRequestId(tab.id)
      setSelectedFolderId(treeIndex.parentFolderById.get(tab.id) ?? '')
      if (tab.kind === 'request') setResponse({ kind: 'empty' })
    } else updateActiveEnvironment(tab.id)
  }

  function closeWorkspaceTab(tab: WorkspaceTab) {
    const key = workspaceTabKey(tab)
    const index = workspaceTabs.findIndex((item) => workspaceTabKey(item) === key)
    if (index < 0) return
    const remaining = workspaceTabs.filter((item) => workspaceTabKey(item) !== key)
    setWorkspaceTabs(remaining)
    if (activeWorkspaceTabKey !== key) return
    const next = remaining[Math.min(index, remaining.length - 1)]
    setActiveWorkspaceTabKey(next ? workspaceTabKey(next) : '')
    if (next?.kind === 'request') {
      setSelectedRequestId(next.id)
      setSelectedFolderId(treeIndex.parentFolderById.get(next.id) ?? '')
      setResponse({ kind: 'empty' })
    } else if (next?.kind === 'docs') {
      setSelectedRequestId(next.id)
      setSelectedFolderId(treeIndex.parentFolderById.get(next.id) ?? '')
    } else if (next?.kind === 'environment') updateActiveEnvironment(next.id)
  }

  function updateEnvironmentTab(environmentId: string, patch: Partial<WorkspaceEnvironment>) {
    if (isReadOnly) return
    updateWorkspaceVariables({
      ...workspaceVariables,
      environments: workspaceVariables.environments.map((environment) => environment.id === environmentId ? { ...environment, ...patch } : environment)
    })
  }

  function restoreTabs(workspaceId: string, nextTree: TreeNode[], variables: WorkspaceVariables) {
    const restored = readWorkspaceTabs(workspaceId, nextTree, variables)
    setWorkspaceTabs(restored.tabs)
    setActiveWorkspaceTabKey(restored.activeKey)
    const selectedRequestTab = restored.tabs.find((tab) => (tab.kind === 'request' || tab.kind === 'docs') && workspaceTabKey(tab) === restored.activeKey)
      ?? restored.tabs.find((tab) => tab.kind === 'request' || tab.kind === 'docs')
    if (selectedRequestTab && (selectedRequestTab.kind === 'request' || selectedRequestTab.kind === 'docs')) {
      setSelectedRequestId(selectedRequestTab.id)
      setSelectedFolderId(findParentFolder(nextTree, selectedRequestTab.id))
    } else {
      setSelectedRequestId(firstRequestId(nextTree))
      setSelectedFolderId(nextTree[0]?.id ?? '')
    }
  }

  function resetTabs(nextTree: TreeNode[]) {
    const requestId = firstRequestId(nextTree)
    const tabs: WorkspaceTab[] = requestId ? [{ kind: 'request', id: requestId }] : []
    setWorkspaceTabs(tabs)
    setActiveWorkspaceTabKey(tabs[0] ? workspaceTabKey(tabs[0]) : '')
    if (requestId) {
      setSelectedRequestId(requestId)
      setSelectedFolderId(findParentFolder(nextTree, requestId))
    } else setSelectedFolderId(nextTree[0]?.id ?? '')
  }

  function openVariableEditor(name: string, sourceValue: string) {
    setQuickEditTarget({ name, sourceValue })
  }

  function saveQuickVariable(name: string, scopeId: string, value: string) {
    const existingEnvironment = workspaceVariables.environments.find((environment) => environment.id === scopeId)
    if (scopeId !== 'global' && existingEnvironment) {
      const existing = existingEnvironment.variables.find((variable) => variable.name.trim() === name)
      const rows = existing
        ? existingEnvironment.variables.map((variable) => variable.id === existing.id ? { ...variable, value } : variable)
        : [...existingEnvironment.variables, { id: crypto.randomUUID(), name, value, secret: false }]
      updateWorkspaceVariables({ ...workspaceVariables, environments: workspaceVariables.environments.map((environment) => environment.id === scopeId ? { ...environment, variables: rows } : environment) })
    } else {
      const existing = workspaceVariables.globals.find((variable) => variable.name.trim() === name)
      const globals = existing
        ? workspaceVariables.globals.map((variable) => variable.id === existing.id ? { ...variable, value } : variable)
        : [...workspaceVariables.globals, { id: crypto.randomUUID(), name, value, secret: false }]
      updateWorkspaceVariables({ ...workspaceVariables, globals })
    }
    setQuickEditTarget(null)
  }

  function stageChanges(changes: WorkspaceChange[], staged: boolean) {
    const base = stagedSnapshot ?? committedTree
    const source = staged ? tree : committedTree
    const treeIds = changes.filter((change) => change.id !== workspaceVariablesChangeId).map((change) => change.id)
    const next = buildStagedSnapshot(base, source, new Set(treeIds))
    const nextStage = JSON.stringify(next) === JSON.stringify(committedTree) ? null : next
    setStagedSnapshot(nextStage)
    if (changes.some((change) => change.id === workspaceVariablesChangeId)) {
      const nextVariables = staged ? shareableWorkspaceVariables(workspaceVariables) : null
      setStagedVariables(nextVariables && JSON.stringify(nextVariables) !== JSON.stringify(committedVariables) ? nextVariables : null)
    }
  }

  function stageChange(change: WorkspaceChange, staged: boolean) {
    stageChanges([change], staged)
  }

  async function saveCommit(event: FormEvent) {
    event.preventDefault()
    if (!activeWorkspace || !commitMessage.trim()) return
    const previousTree = committedTree
    if (!stagedChanges.length) {
      setCommitDialogOpen(false)
      setSyncStatus('Stage at least one change before committing.')
      return
    }
    const stagedTree = stagedSnapshot ?? previousTree as TreeNode[]
    const stagedVariableSnapshot = stagedVariables ?? committedVariables
    if (JSON.stringify(previousTree) === JSON.stringify(stagedTree) && JSON.stringify(committedVariables) === JSON.stringify(stagedVariableSnapshot)) {
      setCommitDialogOpen(false)
      setSyncStatus('There are no staged changes to commit.')
      return
    }
    const commit: LocalCommit = {
      id: crypto.randomUUID(),
      parentIds: activeWorkspace.localHeadId ? [activeWorkspace.localHeadId] : [],
      message: commitMessage.trim(),
      tree: stagedTree,
      variables: shareableWorkspaceVariables(stagedVariableSnapshot),
      createdAt: new Date().toISOString(),
      pushed: false
    }
    await window.apiDesktop.saveCommit(activeWorkspace.id, commit)
    setLocalCommits((current) => [...current.filter((item) => item.id !== commit.id), commit])
    persistActiveWorkspace({ localHeadId: commit.id })
    setStagedSnapshot(null)
    setStagedVariables(null)
    setCommitMessage('')
    setCommitDialogOpen(false)
    setSyncStatus('Commit saved locally.')
  }

  function discardLocalChanges() {
    if (!activeWorkspace) return
    setTree(committedTree)
    const restoredVariables = preserveLocalSecretValues(committedVariables, workspaceVariables)
    setWorkspaceVariables(restoredVariables)
    if (activeEnvironmentId && !restoredVariables.environments.some((environment) => environment.id === activeEnvironmentId)) {
      setActiveEnvironmentId(restoredVariables.environments[0]?.id ?? null)
    }
    setStagedSnapshot(null)
    setStagedVariables(null)
    setDiscardConfirmOpen(false)
    setSyncMenuOpen(false)
    setSyncStatus('Discarded uncommitted changes.')
  }

  async function pullWorkspace() {
    if (!sessionToken || !activeWorkspace?.cloudId) return
    setSyncStatus('Pulling cloud changes…')
    try {
      const result = await apiCall<{ workspace: CloudWorkspace & { tree: TreeNode[]; variables?: WorkspaceVariables; parentIds: string[]; message: string; createdAt: string } }>(`/api/workspaces/${activeWorkspace.cloudId}/sync/pull`, { token: sessionToken })
      const remoteTree = normalizeSharedTree(result.workspace.tree)
      const remoteVariables = normalizeSharedVariables(result.workspace.variables)
      if (result.workspace.headCommitId === activeWorkspace.baseCommitId) { setSyncStatus('Workspace is up to date.'); return }
      const commits = await window.apiDesktop.listCommits(activeWorkspace.id)
      const localCommit = commits.find((item) => item.id === activeWorkspace.localHeadId)
      const expectedTree = localCommit?.tree ?? activeWorkspace.baseTree
      const expectedVariables = normalizeSharedVariables(localCommit?.variables ?? activeWorkspace.baseVariables)
      if (JSON.stringify(expectedTree) !== JSON.stringify(tree) || JSON.stringify(expectedVariables) !== JSON.stringify(shareableWorkspaceVariables(workspaceVariables))) {
        setSyncStatus('Commit local changes before pulling cloud updates.')
        return
      }

      if (activeWorkspace.localHeadId === activeWorkspace.baseCommitId) {
        const nextVariables = preserveLocalSecretValues(remoteVariables, workspaceVariables)
        const nextEnvironmentId = activeEnvironmentId && remoteVariables.environments.some((environment) => environment.id === activeEnvironmentId) ? activeEnvironmentId : remoteVariables.environments[0]?.id ?? null
        const updated = { ...activeWorkspace, tree: remoteTree, baseTree: remoteTree, variables: nextVariables, baseVariables: remoteVariables, activeEnvironmentId: nextEnvironmentId, baseCommitId: result.workspace.headCommitId, localHeadId: result.workspace.headCommitId }
        setLocalWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item))
        await window.apiDesktop.saveWorkspace(updated)
        setTree(remoteTree)
        setWorkspaceVariables(nextVariables)
        setActiveEnvironmentId(nextEnvironmentId)
        setSelectedRequestId(firstRequestId(remoteTree))
        setSyncStatus('Pulled the latest cloud version.')
        return
      }

      const baseVariables = normalizeSharedVariables(activeWorkspace.baseVariables)
      const merged = mergeTreeSnapshots(activeWorkspace.baseTree as TreeNode[], tree, remoteTree, {})
      const variableMerge = mergeWorkspaceVariables(baseVariables, workspaceVariables, remoteVariables)
      if (merged.unresolved.length || variableMerge.conflict) {
        setMergeChoices({})
        setPendingMerge({ remoteHeadId: result.workspace.headCommitId, remoteTree: remoteTree, localTree: tree, baseTree: activeWorkspace.baseTree as TreeNode[], localHeadId: activeWorkspace.localHeadId ?? activeWorkspace.baseCommitId ?? '', conflicts: merged.conflicts, remoteVariables, localVariables: workspaceVariables, baseVariables, variableConflict: variableMerge.conflict })
        setSyncStatus('Review the conflicting workspace items to finish pulling.')
        return
      }
      const mergeCommit: LocalCommit = { id: crypto.randomUUID(), parentIds: [activeWorkspace.localHeadId ?? activeWorkspace.baseCommitId ?? '', result.workspace.headCommitId].filter(Boolean), message: 'Merge remote changes', tree: merged.tree, variables: shareableWorkspaceVariables(variableMerge.variables), createdAt: new Date().toISOString(), pushed: false }
      await window.apiDesktop.saveCommit(activeWorkspace.id, mergeCommit)
      const nextEnvironmentId = activeEnvironmentId && variableMerge.variables.environments.some((environment) => environment.id === activeEnvironmentId) ? activeEnvironmentId : variableMerge.variables.environments[0]?.id ?? null
      const updated = { ...activeWorkspace, tree: merged.tree, baseTree: remoteTree, variables: variableMerge.variables, baseVariables: remoteVariables, activeEnvironmentId: nextEnvironmentId, baseCommitId: result.workspace.headCommitId, localHeadId: mergeCommit.id }
      setLocalWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item))
      await window.apiDesktop.saveWorkspace(updated)
      setTree(merged.tree)
      setWorkspaceVariables(variableMerge.variables)
      setActiveEnvironmentId(nextEnvironmentId)
      setSelectedRequestId(firstRequestId(merged.tree))
      setSyncStatus('Remote updates merged. Push the merge commit to share it.')
    } catch (error) { setSyncStatus(error instanceof Error ? error.message : 'Could not pull cloud changes.') }
  }

  async function pushWorkspace() {
    if (!sessionToken || !activeWorkspace) return
    if (activeWorkspace.role === 'viewer') { setSyncStatus('Viewer access cannot push changes.'); return }
    const commits = await window.apiDesktop.listCommits(activeWorkspace.id)
    let pending = commits.filter((commit) => !commit.pushed)
    if (!pending.length) { setSyncStatus('No local commits to push.'); return }
    let targetWorkspace = activeWorkspace
    let targetCloudId = activeWorkspace.cloudId
    const workspaceAlreadyOnCloud = Boolean(targetCloudId)
    setSyncStatus(targetCloudId ? 'Pushing commits…' : 'Publishing workspace and pushing commits…')
    try {
      if (!targetCloudId) {
        const baseVariables = shareableWorkspaceVariables(normalizeWorkspaceVariables(activeWorkspace.baseVariables ?? activeWorkspace.variables))
        const created = await apiCall<{ workspace: CloudWorkspace & { tree: TreeNode[]; variables?: WorkspaceVariables } }>('/api/workspaces', {
          token: sessionToken,
          method: 'POST',
          body: { name: activeWorkspace.name, tree: stripLocalFilePaths(activeWorkspace.baseTree as TreeNode[]), variables: baseVariables }
        })
        const cloudBaseTree = normalizeSharedTree(created.workspace.tree)
        const cloudBaseVariables = normalizeSharedVariables(created.workspace.variables ?? baseVariables)
        targetCloudId = created.workspace.id
        targetWorkspace = {
          ...activeWorkspace,
          cloudId: targetCloudId,
          role: 'owner',
          tree,
          baseTree: cloudBaseTree,
          variables: workspaceVariables,
          baseVariables: cloudBaseVariables,
          baseCommitId: created.workspace.headCommitId
        }
        await window.apiDesktop.saveWorkspace(targetWorkspace)
        setLocalWorkspaces((current) => current.map((item) => item.id === targetWorkspace.id ? targetWorkspace : item))
        setCloudWorkspaces((current) => [...current.filter((item) => item.id !== targetCloudId), created.workspace])

        const pendingIds = new Set(pending.map((commit) => commit.id))
        pending = pending.map((commit) => {
          const localParents = commit.parentIds.filter((parentId) => pendingIds.has(parentId))
          return { ...commit, parentIds: localParents.length ? localParents : [created.workspace.headCommitId] }
        })
        await Promise.all(pending.map((commit) => window.apiDesktop.saveCommit(activeWorkspace.id, commit)))
        const rebasedById = new Map(pending.map((commit) => [commit.id, commit]))
        setLocalCommits((current) => current.map((commit) => rebasedById.get(commit.id) ?? commit))
      }

      const sharedCommits = pending.map((commit) => ({ ...commit, tree: stripLocalFilePaths(commit.tree), variables: shareableWorkspaceVariables(normalizeWorkspaceVariables(commit.variables)) }))
      const result = await apiCall<{ headCommitId: string }>(`/api/workspaces/${targetCloudId}/sync/push`, { token: sessionToken, method: 'POST', body: { commits: sharedCommits } })
      await Promise.all(pending.map((commit) => window.apiDesktop.saveCommit(activeWorkspace.id, { ...commit, pushed: true })))
      const pushedIds = new Set(pending.map((commit) => commit.id))
      const pushedById = new Map(pending.map((commit) => [commit.id, { ...commit, pushed: true }]))
      setLocalCommits((current) => current.map((commit) => pushedIds.has(commit.id) ? pushedById.get(commit.id)! : commit))
      const pushedTree = pending[pending.length - 1]?.tree ?? tree
      const pushedVariables = normalizeSharedVariables(pending[pending.length - 1]?.variables ?? activeWorkspace.baseVariables)
      const updated = { ...targetWorkspace, cloudId: targetCloudId, tree, baseTree: pushedTree, variables: workspaceVariables, baseVariables: pushedVariables, baseCommitId: result.headCommitId, localHeadId: result.headCommitId }
      setLocalWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item))
      await window.apiDesktop.saveWorkspace(updated)
      setCloudWorkspaces((current) => current.map((item) => item.id === targetCloudId ? { ...item, headCommitId: result.headCommitId } : item))
      setSyncStatus('Pushed commits to the cloud.')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (workspaceAlreadyOnCloud) {
          setSyncStatus('The cloud version advanced. Pulling changes for merge…')
          await pullWorkspace()
        } else setSyncStatus('The workspace was published, but its cloud version changed. Pull before pushing again.')
      } else setSyncStatus(error instanceof Error ? error.message : 'Could not push commits.')
    }
  }

  async function applyMergeResolution() {
    if (!pendingMerge || !activeWorkspace) return
    const merged = mergeTreeSnapshots(pendingMerge.baseTree, pendingMerge.localTree, pendingMerge.remoteTree, mergeChoices)
    const variableMerge = mergeWorkspaceVariables(pendingMerge.baseVariables, pendingMerge.localVariables, pendingMerge.remoteVariables, mergeChoices[workspaceVariablesChangeId])
    if (merged.unresolved.length || variableMerge.conflict && !mergeChoices[workspaceVariablesChangeId]) return
    const commit: LocalCommit = {
      id: crypto.randomUUID(),
      parentIds: [pendingMerge.localHeadId, pendingMerge.remoteHeadId].filter(Boolean),
      message: 'Merge remote changes',
      tree: merged.tree,
      variables: shareableWorkspaceVariables(variableMerge.variables),
      createdAt: new Date().toISOString(),
      pushed: false
    }
    await window.apiDesktop.saveCommit(activeWorkspace.id, commit)
    const nextEnvironmentId = activeEnvironmentId && variableMerge.variables.environments.some((environment) => environment.id === activeEnvironmentId) ? activeEnvironmentId : variableMerge.variables.environments[0]?.id ?? null
    const updated = { ...activeWorkspace, tree: merged.tree, baseTree: pendingMerge.remoteTree, variables: variableMerge.variables, baseVariables: pendingMerge.remoteVariables, activeEnvironmentId: nextEnvironmentId, baseCommitId: pendingMerge.remoteHeadId, localHeadId: commit.id }
    setLocalWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item))
    await window.apiDesktop.saveWorkspace(updated)
    setTree(merged.tree)
    setWorkspaceVariables(variableMerge.variables)
    setActiveEnvironmentId(nextEnvironmentId)
    setSelectedRequestId(firstRequestId(merged.tree))
    setPendingMerge(null)
    setSyncStatus('Conflicts resolved. Push the merge commit to share it.')
  }

  function createFolder(event: FormEvent) {
    event.preventDefault()
    if (isReadOnly) return
    const name = newFolderName.trim()
    if (!name) return
    const folder: Folder = { id: crypto.randomUUID(), kind: 'folder', name, children: [] }
    setTree((current) => {
      const parent = findNode(current, newFolderParentId)
      if (!parent || !isFolder(parent)) return [...current, folder]
      return current.map((node) => node.id === parent.id ? { ...node, children: [...node.children, folder] } : isFolder(node) ? appendToFolder(node, parent.id, folder) : node)
    })
    setSelectedFolderId(folder.id)
    setExpandedFolders((current) => new Set(current).add(folder.id))
    setNewFolderName('')
    setFolderDialogOpen(false)
  }

  function createRequest(folderId = selectedFolderId) {
    if (isReadOnly) return
    const request: SavedRequest = { id: crypto.randomUUID(), kind: 'request', name: 'Untitled request', method: 'GET', url: '', body: '{\n  \n}', bodyMode: 'json', bodyFields: [], headers: [{ id: crypto.randomUUID(), name: 'Accept', value: '*/*', enabled: true }], params: [], auth: { type: 'none' } }
    setTree((current) => {
      const folder = findNode(current, folderId)
      if (!folder || !isFolder(folder)) return [...current, request]
      return current.map((node) => node.id === folder.id ? { ...node, children: [...node.children, request] } : isFolder(node) ? appendToFolder(node, folder.id, request) : node)
    })
    const tab: WorkspaceTab = { kind: 'request', id: request.id }
    setWorkspaceTabs((current) => [...current.filter((item) => workspaceTabKey(item) !== workspaceTabKey(tab)), tab])
    setActiveWorkspaceTabKey(workspaceTabKey(tab))
    setSelectedRequestId(request.id)
    setSelectedFolderId(folderId)
    setExpandedFolders((current) => new Set(current).add(folderId))
    setResponse({ kind: 'empty' })
  }

  function openCreateFolder(parentId: string) {
    setContextMenu(null)
    setNewFolderParentId(parentId)
    setSelectedFolderId(parentId)
    setNewFolderName('')
    setFolderDialogOpen(true)
  }

  function contextMenuHeight(targetNodeId: string | null) {
    if (!targetNodeId) return 92
    const target = treeIndex.nodeById.get(targetNodeId)
    return target && isFolder(target) ? 168 : 132
  }

  function openContextMenu(event: React.MouseEvent<HTMLElement>, parentFolderId: string, targetNodeId: string | null = null) {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 188
    const menuHeight = contextMenuHeight(targetNodeId)
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      parentFolderId,
      targetNodeId
    })
  }

  function openDropdownMenu(event: React.MouseEvent<HTMLElement>, parentFolderId: string, targetNodeId: string | null = null) {
    event.preventDefault()
    event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    const menuHeight = contextMenuHeight(targetNodeId)
    setContextMenu({
      x: Math.max(8, Math.min(bounds.right - 188, window.innerWidth - 196)),
      y: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - menuHeight - 8)),
      parentFolderId,
      targetNodeId
    })
  }

  function openContextMenuFromKeyboard(event: React.KeyboardEvent<HTMLElement>, parentFolderId: string, targetNodeId: string | null = null) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const menuHeight = contextMenuHeight(targetNodeId)
    setContextMenu({
      x: Math.max(8, Math.min(bounds.left + 12, window.innerWidth - 196)),
      y: Math.max(8, Math.min(bounds.bottom, window.innerHeight - menuHeight - 8)),
      parentFolderId,
      targetNodeId
    })
  }

  function createRequestFromMenu() {
    if (!contextMenu) return
    const { parentFolderId } = contextMenu
    setContextMenu(null)
    createRequest(parentFolderId)
  }

  function renameFolderFromMenu() {
    if (!contextMenu?.targetNodeId) return
    const folder = treeIndex.nodeById.get(contextMenu.targetNodeId)
    if (!folder || !isFolder(folder)) return
    setFolderNameDraft(folder.name)
    setRenamingFolderId(folder.id)
    setContextMenu(null)
  }

  function openDeleteConfirmFromMenu() {
    if (!contextMenu?.targetNodeId) return
    const target = treeIndex.nodeById.get(contextMenu.targetNodeId)
    if (!target) return
    setDeleteConfirmTarget({ id: target.id, kind: target.kind, name: target.name })
    setContextMenu(null)
  }

  function confirmDeleteCollectionItem() {
    if (isReadOnly || !deleteConfirmTarget) return
    const target = treeIndex.nodeById.get(deleteConfirmTarget.id)
    if (!target) { setDeleteConfirmTarget(null); return }

    const removedIds = new Set<string>()
    const collectIds = (node: TreeNode) => {
      removedIds.add(node.id)
      if (isFolder(node)) node.children.forEach(collectIds)
    }
    collectIds(target)

    const activeTabIndex = workspaceTabs.findIndex((tab) => workspaceTabKey(tab) === activeWorkspaceTabKey)
    const activeTab = activeTabIndex >= 0 ? workspaceTabs[activeTabIndex] : undefined
    const activeTabRemoved = Boolean(activeTab && removedIds.has(activeTab.id))
    const nextTree = removeNode(tree, target.id).nodes
    const nextTabs = workspaceTabs.filter((tab) => tab.kind === 'environment' || !removedIds.has(tab.id))
    const nextActiveTab = activeTabRemoved
      ? nextTabs[Math.min(activeTabIndex, nextTabs.length - 1)]
      : activeTab ?? nextTabs[0]

    setTree(nextTree)
    setWorkspaceTabs(nextTabs)
    setActiveWorkspaceTabKey(nextActiveTab ? workspaceTabKey(nextActiveTab) : '')
    setExpandedFolders((current) => new Set([...current].filter((id) => !removedIds.has(id))))
    if (nextActiveTab?.kind === 'request' || nextActiveTab?.kind === 'docs') {
      setSelectedRequestId(nextActiveTab.id)
      setSelectedFolderId(findParentFolder(nextTree, nextActiveTab.id))
    } else {
      const fallbackRequestId = firstRequestId(nextTree)
      setSelectedRequestId(fallbackRequestId)
      setSelectedFolderId(fallbackRequestId ? findParentFolder(nextTree, fallbackRequestId) : nextTree.find(isFolder)?.id ?? '')
      if (nextActiveTab?.kind === 'environment') setActiveEnvironmentId(nextActiveTab.id)
    }
    if (activeTabRemoved || removedIds.has(selectedRequestId)) setResponse({ kind: 'empty' })
    setDeleteConfirmTarget(null)
  }

  function commitFolderRename(folderId: string) {
    const name = folderNameDraft.trim()
    if (name) setTree((current) => renameFolder(current, folderId, name))
    setRenamingFolderId('')
    setFolderNameDraft('')
  }

  function cancelFolderRename() {
    cancelRenameOnBlur.current = true
    setRenamingFolderId('')
    setFolderNameDraft('')
  }

  function toggleFolder(folderId: string) {
    setSelectedFolderId(folderId)
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  function moveItem(sourceId: string, targetId: string | null) {
    if (isReadOnly) return
    if (sourceId === targetId) return
    const source = treeIndex.nodeById.get(sourceId)
    if (!source || (targetId && containsId(source, targetId))) return
    const originalParent = treeIndex.parentFolderById.get(sourceId) ?? ''
    const target = targetId ? treeIndex.nodeById.get(targetId) : undefined
    const destination = target && isRequest(target) ? treeIndex.parentFolderById.get(target.id) ?? '' : target && isFolder(target) ? target.id : ''
    if (sourceId === destination || originalParent === destination && targetId === null) return
    setTree((current) => {
      const removed = removeNode(current, sourceId)
      // Dropping on a request inserts before it; dropping on a folder appends to it.
      return insertNode(removed.nodes, source, targetId)
    })
    if (isRequest(source) && source.id === selectedRequestId) setSelectedFolderId(destination)
    if (isFolder(source)) setExpandedFolders((current) => new Set(current).add(source.id))
    if (target && isFolder(target)) setExpandedFolders((current) => new Set(current).add(target.id))
  }

  function handleDrop(event: React.DragEvent, targetId: string | null) {
    event.preventDefault()
    event.stopPropagation()
    const sourceId = event.dataTransfer.getData('text/plain') || draggedId
    if (sourceId) moveItem(sourceId, targetId)
    setDraggedId(null)
  }

  function sendRequest(event: FormEvent) {
    event.preventDefault()
    setSendMenuOpen(false)
    void executeRequest()
  }

  function openClientCode() {
    const request = activeRequestRef.current?.id === selectedRequestId ? activeRequestRef.current : activeRequest
    if (!request || !isRequest(request)) return
    try {
      setClientCode(buildCurlCommand(resolveRequestVariables(request, resolvedVariables)))
      setClientCodeStatus('')
    } catch (error) {
      setClientCode(buildCurlCommand(request))
      setClientCodeStatus(error instanceof Error ? error.message : 'Some variables could not be resolved.')
    }
    setSendMenuOpen(false)
    setClientCodeDialogOpen(true)
  }

  async function copyClientCode() {
    try {
      await navigator.clipboard.writeText(clientCode)
      setClientCodeStatus('Copied to clipboard.')
    } catch {
      setClientCodeStatus('Clipboard access is unavailable. Select the command to copy it.')
    }
  }

  function scheduleRequest(event: FormEvent) {
    event.preventDefault()
    const request = activeRequestRef.current?.id === selectedRequestId ? activeRequestRef.current : activeRequest
    if (!request || !isRequest(request)) return
    const seconds = Math.min(3600, Math.max(1, Number(sendDelaySeconds) || 1))
    const requestSnapshot = structuredClone(request)
    if (sendDelayTimerRef.current !== undefined) window.clearTimeout(sendDelayTimerRef.current)
    setSendDelayDialogOpen(false)
    setSendNotice(`Sending in ${seconds} second${seconds === 1 ? '' : 's'}.`)
    sendDelayTimerRef.current = window.setTimeout(() => {
      sendDelayTimerRef.current = undefined
      setSendNotice('')
      void executeRequest(false, requestSnapshot)
    }, seconds * 1000)
  }

  function cancelScheduledRequest() {
    if (sendDelayTimerRef.current !== undefined) window.clearTimeout(sendDelayTimerRef.current)
    sendDelayTimerRef.current = undefined
    setSendNotice('')
  }

  function stopRepeating() {
    repeatRunIdRef.current += 1
    if (repeatTimerRef.current !== undefined) window.clearTimeout(repeatTimerRef.current)
    repeatTimerRef.current = undefined
    setRepeatRunning(false)
  }

  function startRepeating(event: FormEvent) {
    event.preventDefault()
    const request = activeRequestRef.current?.id === selectedRequestId ? activeRequestRef.current : activeRequest
    if (!request || !isRequest(request)) return
    const intervalMs = Math.min(3600, Math.max(1, Number(repeatIntervalSeconds) || 1)) * 1000
    const requestSnapshot = structuredClone(request)
    const runId = ++repeatRunIdRef.current
    setRepeatRunning(true)
    setRepeatDialogOpen(false)
    const sendAndSchedule = async () => {
      if (repeatRunIdRef.current !== runId) return
      await executeRequest(false, requestSnapshot)
      if (repeatRunIdRef.current !== runId) return
      repeatTimerRef.current = window.setTimeout(() => void sendAndSchedule(), intervalMs)
    }
    void sendAndSchedule()
  }

  function renderTree(nodes: TreeNode[], depth = 0): React.ReactNode {
    return nodes.map((node) => isFolder(node) ? (
      <div key={node.id} className="tree-node" style={{ '--tree-depth': depth } as React.CSSProperties}>
        <div className="tree-folder-line">
          {renamingFolderId === node.id ? <div className="tree-row folder-row folder-row-editing">
            <span className="tree-disclosure" aria-hidden="true">{expandedFolders.has(node.id) ? '⌄' : '›'}</span>
            <CollectionFolderIcon open={expandedFolders.has(node.id)} />
            <Input autoFocus aria-label="Folder name" className="folder-name-editor" maxLength={100} value={folderNameDraft} onChange={(event) => setFolderNameDraft(event.target.value)} onBlur={() => {
              if (cancelRenameOnBlur.current) { cancelRenameOnBlur.current = false; return }
              commitFolderRename(node.id)
            }} onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitFolderRename(node.id) }
              if (event.key === 'Escape') { event.preventDefault(); cancelFolderRename() }
            }} />
            <span className="tree-count">{treeIndex.requestCountByFolderId.get(node.id) ?? 0}</span>
          </div> : <button
            className={cn('tree-row', 'folder-row', selectedFolderId === node.id && 'tree-row-selected', draggedId === node.id && 'tree-row-dragging')}
            aria-expanded={expandedFolders.has(node.id)}
            aria-haspopup="menu"
            draggable
            onDragStart={(event) => { event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; setDraggedId(node.id) }}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
            onDrop={(event) => handleDrop(event, node.id)}
            onClick={() => toggleFolder(node.id)}
            onContextMenu={(event) => openContextMenu(event, node.id, node.id)}
            onKeyDown={(event) => openContextMenuFromKeyboard(event, node.id, node.id)}
          >
            <span className="tree-disclosure" aria-hidden="true">{expandedFolders.has(node.id) ? '⌄' : '›'}</span>
            <CollectionFolderIcon open={expandedFolders.has(node.id)} />
            <span className="tree-label">{node.name}</span>
            <span className="tree-count">{treeIndex.requestCountByFolderId.get(node.id) ?? 0}</span>
          </button>}
          <button className="tree-menu-trigger" aria-label={`Actions for ${node.name}`} aria-haspopup="menu" disabled={isReadOnly} onClick={(event) => openDropdownMenu(event, node.id, node.id)}>⌄</button>
          {changeById.has(node.id) && <span className={`change-badge change-${changeById.get(node.id)?.status}`} aria-label={`${changeStatusText(changeById.get(node.id)?.status)}: ${node.name}`}>{changeStatusCode(changeById.get(node.id)?.status)}</span>}
        </div>
        {expandedFolders.has(node.id) && <div className="tree-children">{node.children.length ? renderTree(node.children, depth + 1) : <div className="tree-empty" style={{ '--tree-depth': depth + 1 } as React.CSSProperties}>Empty folder</div>}</div>}
      </div>
    ) : (
      <div key={node.id} className="tree-request-line" style={{ '--tree-depth': depth } as React.CSSProperties}>
        <button
          className={cn('tree-row', 'request-row', (activeWorkspaceTab?.kind === 'request' || activeWorkspaceTab?.kind === 'docs') && selectedRequestId === node.id && 'tree-row-selected', draggedId === node.id && 'tree-row-dragging')}
          draggable
          onDragStart={(event) => { event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; setDraggedId(node.id) }}
          onDragEnd={() => setDraggedId(null)}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
          onDrop={(event) => handleDrop(event, node.id)}
          onClick={() => activeWorkspaceTab?.kind === 'docs' ? openDocsTab(node.id) : openRequestTab(node.id)}
          onContextMenu={(event) => openContextMenu(event, treeIndex.parentFolderById.get(node.id) ?? '', node.id)}
          onKeyDown={(event) => openContextMenuFromKeyboard(event, treeIndex.parentFolderById.get(node.id) ?? '', node.id)}
        >
          <span className={`method method-${node.method.toLowerCase()}`}>{node.method}</span>
          <span className="tree-label request-copy"><strong title={node.name}>{node.name}</strong></span>
          {changeById.has(node.id) && <span className={`change-badge change-${changeById.get(node.id)?.status}`} aria-label={`${changeStatusText(changeById.get(node.id)?.status)}: ${node.name}`}>{changeStatusCode(changeById.get(node.id)?.status)}</span>}
        </button>
        <button type="button" className="tree-menu-trigger request-menu-trigger" aria-label={`Actions for ${node.name}`} aria-haspopup="menu" disabled={isReadOnly} onClick={(event) => openDropdownMenu(event, treeIndex.parentFolderById.get(node.id) ?? '', node.id)}>⌄</button>
      </div>
    ))
  }

  return (
    <main ref={appShellRef} className="app-shell" style={{ '--sidebar-width': `${collectionWidth}px` } as React.CSSProperties}>
      <header className="topbar">
        <div className="wordmark">API Documentation</div>
        <div className="topbar-actions">
          {user ? <>
            <Button variant="outline" size="sm" onClick={() => setCreateWorkspaceOpen(true)}>New cloud workspace</Button>
            <Button variant="outline" size="sm" onClick={() => { setInviteError(''); setInviteNotice(''); setTeamDialogOpen(true) }}>{activeWorkspace?.cloudId && activeWorkspace.role === 'owner' ? 'Team' : 'Join workspace'}</Button>
            <span className="signed-in-email">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button>
          </> : null}
          {updateStatus?.state === 'available' && <Button size="sm" onClick={() => void window.apiDesktop.downloadUpdate(updateStatus.version)}>Update to v{updateStatus.version}</Button>}
          <AuthDialog showTrigger={!user} onBeginSignIn={beginBrowserSignIn} openRequest={authOpenRequest} initialError={authError} onOpen={clearAuthError} />
        </div>
      </header>

      <Dialog open={Boolean(updateStatus && updateStatus.state !== 'available')} onOpenChange={(open) => { if (!open && updateStatus?.state === 'error') setUpdateStatus(null) }}>
        <DialogContent>
          {updateStatus?.state === 'error' ? <>
            <DialogHeader><DialogTitle>Update failed</DialogTitle><DialogDescription>{updateStatus.message}</DialogDescription></DialogHeader>
            <div className="dialog-form"><Button type="button" onClick={() => setUpdateStatus(null)}>Close</Button></div>
          </> : <>
            <DialogHeader><DialogTitle>Updating to v{updateStatus?.version}</DialogTitle><DialogDescription>{updateStatus?.state === 'downloaded' ? 'Download complete. Restarting to finish the update…' : 'Downloading the update. The app will restart when it is ready.'}</DialogDescription></DialogHeader>
            {updateStatus?.state === 'downloading' && <div className="dialog-form">
              <div style={{ height: 8, borderRadius: 4, background: 'var(--graphite-line-soft)', overflow: 'hidden' }}><div style={{ width: `${updateStatus.percent}%`, height: '100%', background: 'var(--graphite-blue)', transition: 'width 200ms ease' }} /></div>
              <p>{updateStatus.percent}%</p>
            </div>}
          </>}
        </DialogContent>
      </Dialog>
      <VariablesDialog open={variablesDialogOpen} onOpenChange={setVariablesDialogOpen} variables={workspaceVariables} activeEnvironmentId={activeEnvironmentId} readOnly={Boolean(isReadOnly)} secureStorageAvailable={secureStorageAvailable} onVariablesChange={updateWorkspaceVariables} onActiveEnvironmentChange={(id) => id ? openEnvironmentTab(id) : updateActiveEnvironment(null)} />
      <VariableQuickEditDialog target={quickEditTarget} variables={workspaceVariables} activeEnvironmentId={activeEnvironmentId} resolvedValues={resolvedVariables} readOnly={Boolean(isReadOnly)} onClose={() => setQuickEditTarget(null)} onSave={saveQuickVariable} />
      <OpenApiDialog open={openApiDialogOpen} onOpenChange={setOpenApiDialogOpen} tree={tree} workspaceName={activeWorkspace?.name ?? 'My workspace'} readOnly={Boolean(isReadOnly)} onImport={(imported) => {
        setTree((current) => [...current, ...imported])
        const importedRequestId = firstRequestId(imported)
        if (importedRequestId) {
          const tab: WorkspaceTab = { kind: 'request', id: importedRequestId }
          setWorkspaceTabs((current) => [...current.filter((item) => workspaceTabKey(item) !== workspaceTabKey(tab)), tab])
          setActiveWorkspaceTabKey(workspaceTabKey(tab))
          setSelectedRequestId(importedRequestId)
          setSelectedFolderId(findParentFolder(imported, importedRequestId))
          setResponse({ kind: 'empty' })
        }
        const folders = new Set<string>()
        const collectFolders = (nodes: TreeNode[]) => nodes.forEach((node) => { if (node.kind === 'folder') { folders.add(node.id); collectFolders(node.children) } })
        collectFolders(imported)
        setExpandedFolders((current) => new Set([...current, ...folders]))
      }} />

      <aside className="sidebar" aria-label="Workspace">
        <div className="sidebar-heading">
          <div><p className="sidebar-kicker">Workspace</p><h1>Collections</h1></div>
          <Button type="button" variant="outline" size="sm" className="openapi-trigger" onClick={() => setOpenApiDialogOpen(true)}>OpenAPI</Button>
          <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
            <DialogContent>
              <DialogHeader><DialogTitle>Create folder</DialogTitle><DialogDescription>Create a folder inside {newFolderParentId ? treeIndex.nodeById.get(newFolderParentId)?.name ?? 'the selected folder' : 'Workspace'}.</DialogDescription></DialogHeader>
              <form className="dialog-form" onSubmit={createFolder}>
                <label htmlFor="folder-name">Folder name</label>
                <Input id="folder-name" autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="e.g. Payments API" />
                <Button type="submit" disabled={!newFolderName.trim()}>Create folder</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <nav className="tree-list" aria-label="Workspace folders and requests" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => handleDrop(event, null)}>
          <div className="workspace-root-line">
            <Select value={currentWorkspaceId} onValueChange={activateWorkspace}>
              <SelectTrigger
                aria-label="Select workspace"
                className="workspace-root-select"
                onContextMenu={(event) => openContextMenu(event, '')}
                onKeyDown={(event) => openContextMenuFromKeyboard(event, '')}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
                onDrop={(event) => handleDrop(event, null)}
              >
                <SelectValue className="workspace-root-name" placeholder="Choose workspace">
                  {activeWorkspace && <span className="workspace-selected-value"><WorkspaceStorageIcon kind={activeWorkspace.cloudId ? 'cloud' : 'local'} /><span className="workspace-selected-name">{activeWorkspace.name}</span></span>}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="workspace-select-content">
                {localWorkspaces.map((workspace) => {
                  const isCloudWorkspace = Boolean(workspace.cloudId)
                  const storageLabel = isCloudWorkspace ? `Cloud${workspace.role ? ` · ${workspace.role}` : ''}` : 'Local vault'
                  return <SelectItem key={workspace.id} value={workspace.id} textValue={`${workspace.name} ${storageLabel}`}>
                    <span className="workspace-option">
                      <WorkspaceStorageIcon kind={isCloudWorkspace ? 'cloud' : 'local'} className="workspace-option-icon" />
                      <span className="workspace-option-name">{workspace.name}</span>
                      <small className="workspace-option-meta">{storageLabel}</small>
                    </span>
                  </SelectItem>
                })}
              </SelectContent>
            </Select>
          <button className="tree-menu-trigger workspace-menu-trigger" aria-label="Workspace actions" aria-haspopup="menu" disabled={isReadOnly} onClick={(event) => openDropdownMenu(event, '')}>⌄</button>
          </div>
          {tree.length ? renderTree(tree) : <p className="collection-empty">Workspace is empty. Add a folder or request to get started.</p>}
        </nav>
        <div className="sidebar-footer">
          {syncMenuOpen && <>
            <button type="button" className="sidebar-sync-dismiss" aria-label="Close sync menu" onMouseDown={() => setSyncMenuOpen(false)} />
            <div id="sidebar-sync-menu" className="sidebar-sync-menu" role="menu" aria-label="Workspace sync actions" onKeyDown={(event) => {
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
              const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement)
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const direction = event.key === 'ArrowDown' ? 1 : -1
                items[(activeIndex + direction + items.length) % items.length]?.focus()
              } else if (event.key === 'Escape') setSyncMenuOpen(false)
            }}>
              <div className="sidebar-sync-menu-heading">
                <WorkspaceStorageIcon kind={activeWorkspace?.cloudId ? 'cloud' : 'local'} className="sidebar-sync-menu-icon" />
                <div><strong>{activeWorkspace?.name ?? 'Workspace'}</strong><small>{activeWorkspace?.cloudId ? cloudUpdateAvailable ? 'Cloud updates available' : 'Cloud workspace' : 'Local vault'}</small></div>
              </div>
              <div className="sidebar-sync-menu-divider" />
              <button type="button" role="menuitem" autoFocus onClick={() => {
                setSyncMenuOpen(false)
                setCommitDialogView('history')
                setSelectedHistoryCommitId('')
                setSelectedHistoryChangeId('')
                setCommitDialogOpen(true)
              }}><span aria-hidden="true">◷</span>History{historyCommits.length > 0 && <small>{historyCommits.length}</small>}</button>
              <button type="button" role="menuitem" disabled={!workspaceChanges.length} onClick={() => { setSyncMenuOpen(false); setDiscardConfirmOpen(true) }}><span aria-hidden="true">↶</span>Discard local changes</button>
              <button type="button" role="menuitem" disabled={isReadOnly || !workspaceChanges.length} onClick={() => {
                setSyncMenuOpen(false)
                setCommitDialogView('changes')
                setCommitMessage('')
                setSelectedChangeId('')
                setCommitDialogOpen(true)
              }}><span aria-hidden="true">⬡</span>Commit{workspaceChanges.length > 0 && <small>{workspaceChanges.length}</small>}</button>
              <div className="sidebar-sync-menu-divider" />
              <button type="button" role="menuitem" disabled={!sessionToken || !activeWorkspace?.cloudId} onClick={() => { setSyncMenuOpen(false); void pullWorkspace() }}><span aria-hidden="true">↓</span>Pull{cloudUpdateAvailable && <small>Updates available</small>}</button>
              <button type="button" role="menuitem" disabled={!sessionToken || isReadOnly || !pendingPushCount} onClick={() => { setSyncMenuOpen(false); void pushWorkspace() }}><span aria-hidden="true">↑</span>Push{pendingPushCount > 0 && <small>{pendingPushCount} {pendingPushCount === 1 ? 'commit' : 'commits'}</small>}</button>
              {pushDisabledReason && <p className="sidebar-sync-hint" role="status">{pushDisabledReason}</p>}
            </div>
          </>}
          <button type="button" className="sidebar-sync-trigger" aria-haspopup="menu" aria-expanded={syncMenuOpen} aria-controls="sidebar-sync-menu" disabled={!activeWorkspace} onClick={() => setSyncMenuOpen((open) => !open)}>
            <WorkspaceStorageIcon kind={activeWorkspace?.cloudId ? 'cloud' : 'local'} className="sidebar-sync-trigger-icon" />
            <span className="sidebar-sync-trigger-label">Changes</span>
            {workspaceChanges.length > 0 && <span className="sidebar-sync-trigger-count">{workspaceChanges.length}</span>}
            <span className="sidebar-sync-trigger-meta" aria-label={`${activeWorkspace?.cloudId ? `${pendingPushCount} commits to push` : 'Saved locally'}${cloudUpdateAvailable ? ', cloud update available' : ''}`}>
              {cloudUpdateAvailable && <span title="Cloud updates available">↓</span>}
              {pendingPushCount > 0 && activeWorkspace?.cloudId && <span title={`${pendingPushCount} commits to push`}>↑{pendingPushCount}</span>}
              {!cloudUpdateAvailable && (!pendingPushCount || !activeWorkspace?.cloudId) && <span title={activeWorkspace?.cloudId ? 'Up to date' : 'Saved locally'}>•</span>}
            </span>
            <span className="sidebar-sync-trigger-chevron" aria-hidden="true">⌃</span>
          </button>
          <div className="sidebar-footer-status" role="status" aria-live="polite">
            {workspaceChanges.length > 0 && <span>{workspaceChanges.length} local {workspaceChanges.length === 1 ? 'change' : 'changes'}</span>}
            {pendingPushCount > 0 && activeWorkspace?.cloudId && <span>{pendingPushCount} {pendingPushCount === 1 ? 'commit' : 'commits'} to push</span>}
            {pendingPushCount > 0 && !activeWorkspace?.cloudId && <span>{pendingPushCount} local {pendingPushCount === 1 ? 'commit' : 'commits'}</span>}
            {cloudUpdateAvailable && <span className="sidebar-cloud-status">Cloud updates available</span>}
            {!workspaceChanges.length && !pendingPushCount && !cloudUpdateAvailable && !activeWorkspace?.cloudId && <span>Saved locally</span>}
            {!workspaceChanges.length && !pendingPushCount && !cloudUpdateAvailable && activeWorkspace?.cloudId && cloudHeadCommitId && <span>Cloud workspace up to date</span>}
            {!cloudHeadCommitId && activeWorkspace?.cloudId && <span>Checking cloud status…</span>}
          </div>
        </div>
      </aside>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize collections panel"
        aria-orientation="vertical"
        aria-valuemin={minCollectionWidth}
        aria-valuemax={Math.round(collectionWidthLimit())}
        aria-valuenow={Math.round(Math.min(collectionWidth, collectionWidthLimit()))}
        aria-valuetext={`${Math.round(Math.min(collectionWidth, collectionWidthLimit()))} pixels`}
        tabIndex={0}
        onPointerDown={startCollectionResize}
        onPointerMove={moveCollectionResize}
        onPointerUp={finishCollectionResize}
        onPointerCancel={finishCollectionResize}
        onLostPointerCapture={finishCollectionResize}
        onKeyDown={handleCollectionResizeKeyDown}
      />

      <section className="workspace" aria-label="Request workspace">
        <div className="workspace-tabs-row">
          <div className="workspace-tabbar" role="tablist" aria-label="Open workspace tabs">
            {workspaceTabs.map((tab) => {
              const request = tab.kind === 'request' || tab.kind === 'docs' ? treeIndex.nodeById.get(tab.id) : undefined
              const environment = tab.kind === 'environment' ? workspaceVariables.environments.find((item) => item.id === tab.id) : undefined
              if ((tab.kind === 'request' || tab.kind === 'docs') && (!request || !isRequest(request)) || tab.kind === 'environment' && !environment) return null
              const title = tab.kind === 'docs' ? `${request && isRequest(request) ? request.name : 'Request'} · Docs` : request && isRequest(request) ? request.name : environment?.name ?? 'Environment'
              const isActive = workspaceTabKey(tab) === activeWorkspaceTabKey
              return <div className="workspace-tab-item" key={workspaceTabKey(tab)}>
                <button type="button" role="tab" aria-selected={isActive} className={cn('workspace-tab', isActive && 'workspace-tab-active')} onClick={() => selectWorkspaceTab(tab)}>
                  {tab.kind === 'docs'
                    ? <span className="workspace-tab-docs" aria-hidden="true">DOCS</span>
                    : request && isRequest(request)
                      ? <span className={`workspace-tab-method method-${request.method.toLowerCase()}`}>{request.method}</span>
                      : <span className="workspace-tab-environment" aria-hidden="true">◎</span>}
                  <span className="workspace-tab-title">{title}</span>
                  {tab.kind !== 'environment' && request && isRequest(request) && changeById.has(request.id) && <span className="workspace-tab-change" aria-label="Has uncommitted changes" />}
                </button>
                <button type="button" className="workspace-tab-close" aria-label={`Close ${title} tab`} onClick={() => closeWorkspaceTab(tab)}>×</button>
              </div>
            })}
            {!workspaceTabs.length && <span className="workspace-tab-empty">Open a request from the collection.</span>}
          </div>
          <div className="workspace-tab-actions">
            <Button type="button" variant="outline" size="sm" className="workspace-docs-button" disabled={!firstRequestId(tree)} onClick={openCurrentDocs}>Read docs</Button>
            <div className="active-environment-control"><span>Environment</span><Select value={workspaceVariables.environments.some((environment) => environment.id === activeEnvironmentId) ? activeEnvironmentId as string : 'none'} onValueChange={(id) => id === 'none' ? updateActiveEnvironment(null) : openEnvironmentTab(id)} disabled={!workspaceVariables.environments.length}><SelectTrigger aria-label="Active environment" className="active-environment-select"><SelectValue placeholder="No environment" /></SelectTrigger><SelectContent><SelectItem value="none">No environment</SelectItem>{workspaceVariables.environments.map((environment) => <SelectItem key={environment.id} value={environment.id}>{environment.name}</SelectItem>)}</SelectContent></Select></div>
            <Button type="button" variant="outline" size="sm" className="workspace-variables-button" disabled={!activeWorkspace} onClick={() => setVariablesDialogOpen(true)}>Variables</Button>
          </div>
        </div>
        {activeWorkspaceTab?.kind === 'environment' ? activeEnvironmentTab ? <section className="request-card environment-tab-panel" aria-label={`${activeEnvironmentTab.name} environment`}>
          <div className="environment-tab-heading">
            <div><p className="section-kicker">Environment / Variables</p><Input aria-label="Environment name" maxLength={100} value={activeEnvironmentTab.name} readOnly={isReadOnly} onChange={(event) => updateEnvironmentTab(activeEnvironmentTab.id, { name: event.target.value })} /></div>
            <Button type="button" variant={activeEnvironmentId === activeEnvironmentTab.id ? 'default' : 'outline'} size="sm" disabled={isReadOnly || activeEnvironmentId === activeEnvironmentTab.id} onClick={() => updateActiveEnvironment(activeEnvironmentTab.id)}>{activeEnvironmentId === activeEnvironmentTab.id ? 'Active for requests' : 'Use for requests'}</Button>
          </div>
          <p className="variable-policy">Values here override matching Global variables when this environment is active. Secret values stay on this device and out of cloud sync.</p>
          {!secureStorageAvailable && <p className="variable-storage-warning" role="status">Secure storage is unavailable. Secret values will last only until the app closes.</p>}
          <VariableRows rows={activeEnvironmentTab.variables} readOnly={Boolean(isReadOnly)} onChange={(rows) => updateEnvironmentTab(activeEnvironmentTab.id, { variables: rows })} />
        </section> : <section className="request-card workspace-full-panel"><StateMessage title="Environment unavailable" description="It may have been removed from this workspace." /></section> : activeWorkspaceTab?.kind === 'docs' ? activeDocsRequest && isRequest(activeDocsRequest) ? <ApiReferencePage request={activeDocsRequest} folderName={activeFolder && isFolder(activeFolder) ? activeFolder.name : 'Workspace'} onOpenRequest={() => openRequestTab(activeDocsRequest.id)} onOpenOpenApi={() => setOpenApiDialogOpen(true)} /> : <section className="request-card docs-page"><StateMessage title="Endpoint docs unavailable" description="Choose an endpoint in the collection to open its documentation." /></section> : <>
        <form className="request-card" onSubmit={sendRequest}>
          {activeWorkspaceTab?.kind === 'request' && activeRequest && isRequest(activeRequest) ? <>
            <div className="request-card-heading"><div><p className="section-kicker">{activeFolder && isFolder(activeFolder) ? activeFolder.name : 'Workspace'} / Request builder</p><DebouncedInput key={currentWorkspaceId + ':' + activeRequest.id + ':name'} aria-label="Request name" className="request-name-input" value={activeRequest.name} readOnly={isReadOnly} onValueChange={(value) => updateActiveRequest({ name: value })} /></div><div className="request-heading-actions"><span className="request-status">{activeWorkspace?.cloudId ? activeWorkspace.role : 'Saved locally'}</span><Button type="button" variant="outline" size="sm" className="request-view-docs" onClick={() => openDocsTab(activeRequest.id)}>View docs</Button></div></div>
            <div className="request-line">
              <Select value={activeRequest.method} onValueChange={(value) => updateActiveRequest({ method: value })} disabled={isReadOnly}><SelectTrigger aria-label="HTTP method" className="method-select"><SelectValue /></SelectTrigger><SelectContent>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>
              <VariableUrlField key={currentWorkspaceId + ':' + activeRequest.id + ':url'} aria-label="Request URL" className="url-input" value={activeRequest.url} suggestions={variableSuggestions} onVariableClick={openVariableEditor} readOnly={isReadOnly} onValueChange={(value) => updateActiveRequest({ url: value })} spellCheck={false} placeholder="https://api.example.com/resource" />
              <div className="send-control">
                <Button type="submit" className="send-primary" disabled={response.kind === 'loading'}>{response.kind === 'loading' ? 'Sending…' : 'Send'}</Button>
                <Button type="button" variant="default" size="sm" className="send-options-trigger" ref={sendOptionsButtonRef} aria-label="Send options" aria-haspopup="menu" aria-expanded={sendMenuOpen} onClick={() => setSendMenuOpen((open) => !open)}>⌄</Button>
                {sendMenuOpen && <>
                  <button type="button" className="send-menu-dismiss" aria-label="Close send options" onClick={() => setSendMenuOpen(false)} />
                  <div className="send-options-menu" role="menu" aria-label="Send request options" onKeyDown={(event) => {
                    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
                    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement)
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      const direction = event.key === 'ArrowDown' ? 1 : -1
                      items[(activeIndex + direction + items.length) % items.length]?.focus()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setSendMenuOpen(false)
                      sendOptionsButtonRef.current?.focus()
                    }
                  }}>
                    <div className="send-menu-section">Basic</div>
                    <button type="button" role="menuitem" autoFocus onClick={() => { setSendMenuOpen(false); void executeRequest() }}><span>Send Now</span><kbd>Ctrl + Enter</kbd></button>
                    <button type="button" role="menuitem" onClick={openClientCode}><span>Generate Client Code</span></button>
                    <div className="send-menu-section send-menu-section-advanced">Advanced</div>
                    <button type="button" role="menuitem" onClick={() => { setSendMenuOpen(false); setSendDelayDialogOpen(true) }}><span>Send After Delay</span></button>
                    {repeatRunning
                      ? <button type="button" role="menuitem" onClick={() => { setSendMenuOpen(false); stopRepeating() }}><span>Stop Repeating</span></button>
                      : <button type="button" role="menuitem" onClick={() => { setSendMenuOpen(false); setRepeatDialogOpen(true) }}><span>Repeat on Interval</span></button>}
                    <button type="button" role="menuitemcheckbox" className="send-menu-toggle" aria-checked={downloadAfterSend} onClick={() => setDownloadAfterSend((enabled) => !enabled)}><span className="send-menu-check" aria-hidden="true">{downloadAfterSend ? '✓' : ''}</span><span>Download After Send</span></button>
                    <button type="button" role="menuitem" className="send-menu-last" onClick={() => { setSendMenuOpen(false); void executeRequest(true) }}><span>Send And Download</span></button>
                  </div>
                </>}
              </div>
            </div>
            {(sendNotice || repeatRunning) && <div className="send-schedule-notice" role="status">
              <span>{sendNotice || `Repeating every ${repeatIntervalSeconds} second${Number(repeatIntervalSeconds) === 1 ? '' : 's'}.`}</span>
              <Button type="button" variant="ghost" size="sm" onClick={sendNotice ? cancelScheduledRequest : stopRepeating}>{sendNotice ? 'Cancel' : 'Stop'}</Button>
            </div>}
            <Tabs defaultValue="params" className="request-tabs">
              <TabsList aria-label="Request configuration">
                <TabsTrigger value="params">Params{requestTabIndicators?.activeParams ? <span className="request-tab-count" aria-hidden="true">{requestTabIndicators.activeParams}</span> : null}{requestTabIndicators?.activeParams ? <span className="sr-only">{requestTabIndicators.activeParams} active parameters</span> : null}</TabsTrigger>
                <TabsTrigger value="body">Body{requestTabIndicators?.hasBody && <><span className="request-tab-dot" aria-hidden="true" /><span className="sr-only">Body configured</span></>}</TabsTrigger>
                <TabsTrigger value="auth">Auth{requestTabIndicators?.hasAuth && <><span className="request-tab-dot" aria-hidden="true" /><span className="sr-only">Authorization configured</span></>}</TabsTrigger>
                <TabsTrigger value="headers">Headers{requestTabIndicators?.headers ? <span className="request-tab-count" aria-hidden="true">{requestTabIndicators.headers}</span> : null}{requestTabIndicators?.headers ? <span className="sr-only">{requestTabIndicators.headers} active headers</span> : null}</TabsTrigger>
                <TabsTrigger value="responses">Responses{activeRequest.responses?.length ? <span className="request-tab-count">{activeRequest.responses.length}</span> : null}</TabsTrigger>
                <TabsTrigger value="docs">Docs</TabsTrigger>
              </TabsList>
              <TabsContent value="params" className="editor-pane"><ParamsEditor key={currentWorkspaceId + ':' + activeRequest.id} request={activeRequest} readOnly={isReadOnly} suggestions={variableSuggestions} onVariableClick={openVariableEditor} onChange={updateActiveRequest} /></TabsContent>
              <TabsContent value="body" className="editor-pane"><BodyEditor key={currentWorkspaceId + ':' + activeRequest.id} request={activeRequest} readOnly={isReadOnly} suggestions={variableSuggestions} onVariableClick={openVariableEditor} onChange={updateActiveRequest} /></TabsContent>
              <TabsContent value="auth" className="editor-pane"><AuthEditor key={currentWorkspaceId + ':' + activeRequest.id} request={activeRequest} readOnly={isReadOnly} suggestions={variableSuggestions} onVariableClick={openVariableEditor} onChange={updateActiveRequest} /></TabsContent>
              <TabsContent value="headers" className="editor-pane"><HeaderEditor key={currentWorkspaceId + ':' + activeRequest.id} request={activeRequest} readOnly={isReadOnly} suggestions={variableSuggestions} onVariableClick={openVariableEditor} onChange={updateActiveRequest} /></TabsContent>
              <TabsContent value="responses" className="editor-pane"><ResponseEditor key={currentWorkspaceId + ':' + activeRequest.id} responses={activeRequest.responses ?? []} readOnly={isReadOnly} onChange={(responses) => updateActiveRequest({ responses })} /></TabsContent>
              <TabsContent value="docs" className="editor-pane"><DebouncedTextarea key={currentWorkspaceId + ':' + activeRequest.id + ':docs'} aria-label="Request documentation" className="request-docs-field" maxLength={100000} placeholder="Describe this endpoint, its inputs, and expected response." value={activeRequest.documentation ?? ''} readOnly={isReadOnly} onValueChange={(value) => updateActiveRequest({ documentation: value })} /></TabsContent>
            </Tabs>
          </> : <StateMessage title="No request selected" description="Choose a request or create one in the selected folder." />}
        </form>
        <Dialog open={sendDelayDialogOpen} onOpenChange={setSendDelayDialogOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Send after delay</DialogTitle><DialogDescription>Run this request once after the selected delay.</DialogDescription></DialogHeader>
            <form className="dialog-form send-timer-form" onSubmit={scheduleRequest}>
              <label htmlFor="send-delay-seconds">Delay in seconds</label>
              <Input id="send-delay-seconds" type="number" min="1" max="3600" value={sendDelaySeconds} onChange={(event) => setSendDelaySeconds(event.target.value)} />
              <Button type="submit">Schedule request</Button>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog open={repeatDialogOpen} onOpenChange={setRepeatDialogOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Repeat request</DialogTitle><DialogDescription>Send the current request repeatedly until you stop it.</DialogDescription></DialogHeader>
            <form className="dialog-form send-timer-form" onSubmit={startRepeating}>
              <label htmlFor="repeat-interval-seconds">Interval in seconds</label>
              <Input id="repeat-interval-seconds" type="number" min="1" max="3600" value={repeatIntervalSeconds} onChange={(event) => setRepeatIntervalSeconds(event.target.value)} />
              <Button type="submit">Start repeating</Button>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog open={clientCodeDialogOpen} onOpenChange={setClientCodeDialogOpen}>
          <DialogContent className="client-code-dialog">
            <DialogHeader><DialogTitle>Generate Client Code</DialogTitle><DialogDescription>cURL command for the current request.</DialogDescription></DialogHeader>
            <Textarea aria-label="Generated cURL command" className="client-code-textarea code-field" readOnly value={clientCode} spellCheck={false} />
            <p className="client-code-note">The command includes the authorization values configured for this request.</p>
            <div className="client-code-actions"><span role="status">{clientCodeStatus}</span><Button type="button" onClick={() => void copyClientCode()}>Copy code</Button></div>
          </DialogContent>
        </Dialog>
        <ResponseInspector response={response} responseView={responseView} onResponseViewChange={setResponseView} />
        </>}
      </section>
      {contextMenu && !isReadOnly && <>
        <div className="context-menu-dismiss" aria-hidden="true" onMouseDown={() => setContextMenu(null)} />
        <div className="tree-context-menu" role="menu" aria-label="Collection item actions" style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={(event) => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
          const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            items[(activeIndex + direction + items.length) % items.length]?.focus()
          } else if (event.key === 'Escape') setContextMenu(null)
        }}>
          <button role="menuitem" autoFocus onClick={() => openCreateFolder(contextMenu.parentFolderId)}><span aria-hidden="true">＋</span>Create folder</button>
          <button role="menuitem" onClick={createRequestFromMenu}><span aria-hidden="true">↳</span>Create request</button>
          {contextMenu.targetNodeId && (() => {
            const target = treeIndex.nodeById.get(contextMenu.targetNodeId)
            return target && isFolder(target) ? <>
              <div className="tree-context-menu-divider" role="separator" />
              <button role="menuitem" onClick={renameFolderFromMenu}><span aria-hidden="true">✎</span>Rename folder</button>
              <button role="menuitem" className="context-menu-danger" onClick={openDeleteConfirmFromMenu}><span aria-hidden="true">×</span>Delete folder</button>
            </> : target && isRequest(target) ? <>
              <div className="tree-context-menu-divider" role="separator" />
              <button role="menuitem" className="context-menu-danger" onClick={openDeleteConfirmFromMenu}><span aria-hidden="true">×</span>Delete request</button>
            </> : null
          })()}
        </div>
      </>}
      <Dialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create cloud workspace</DialogTitle><DialogDescription>Publish the current local workspace so your team can join it.</DialogDescription></DialogHeader>
          <form className="dialog-form" onSubmit={createCloudWorkspace}>
            <label htmlFor="cloud-workspace-name">Workspace name</label>
            <Input id="cloud-workspace-name" autoFocus required maxLength={100} value={cloudWorkspaceName} onChange={(event) => setCloudWorkspaceName(event.target.value)} placeholder="e.g. Platform API" />
            <Button type="submit" disabled={!sessionToken || !cloudWorkspaceName.trim()}>Create workspace</Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={teamDialogOpen} onOpenChange={setTeamDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Workspace team</DialogTitle><DialogDescription>{activeWorkspace?.role === 'owner' ? `Invite a teammate to ${activeWorkspace.name} by email.` : 'Paste an invite link to join a workspace.'}</DialogDescription></DialogHeader>
          <div className="dialog-form">
            {activeWorkspace?.role === 'owner' && <>
              <p className="invite-help">The invitation is single-use, expires in 7 days, and must be accepted by the invited account email.</p>
              <label htmlFor="invite-email">Teammate email</label>
              <Input id="invite-email" type="email" autoComplete="email" required value={inviteEmailDraft} onChange={(event) => setInviteEmailDraft(event.target.value)} placeholder="teammate@example.com" />
              <label htmlFor="invite-role">Invite role</label>
              <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as 'editor' | 'viewer')}><SelectTrigger id="invite-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="editor">Editor</SelectItem><SelectItem value="viewer">Viewer</SelectItem></SelectContent></Select>
              <Button type="button" onClick={() => void createInvite()}>Send invitation</Button>
            </>}
            {inviteLink && <div className="invite-link-row"><Input aria-label="Invite link" readOnly value={inviteLink} /><Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(inviteLink)}>Copy</Button></div>}
            <form className="invite-accept-form" onSubmit={acceptInvite}>
              <label htmlFor="invite-token">Accept an invite</label>
              <Input id="invite-token" value={inviteTokenDraft} onChange={(event) => setInviteTokenDraft(event.target.value)} placeholder="Paste invite link or token" />
              <Button type="submit" variant="outline" disabled={!inviteTokenDraft.trim()}>Join workspace</Button>
            </form>
            {inviteError && <p className="dialog-error" role="status">{inviteError}</p>}
            {inviteNotice && <p className="dialog-success" role="status">{inviteNotice}</p>}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Discard local changes?</DialogTitle><DialogDescription>This restores the collection and variable definitions to the latest local commit. Uncommitted edits will be lost; secret values remain stored on this device.</DialogDescription></DialogHeader>
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={() => setDiscardConfirmOpen(false)}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={discardLocalChanges}>Discard changes</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmTarget !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deleteConfirmTarget?.kind === 'folder' ? 'Delete folder?' : 'Delete request?'}</DialogTitle>
            <DialogDescription>
              {deleteConfirmTarget?.kind === 'folder'
                ? (() => { const requestCount = treeIndex.requestCountByFolderId.get(deleteConfirmTarget.id) ?? 0; return `Delete “${deleteConfirmTarget.name}” and all of its contents (${requestCount} request${requestCount === 1 ? '' : 's'})? This appears in Changes and will only be shared after you commit and push.` })()
                : `Delete “${deleteConfirmTarget?.name ?? 'this request'}”? This appears in Changes and will only be shared after you commit and push.`}
            </DialogDescription>
          </DialogHeader>
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={() => setDeleteConfirmTarget(null)}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={confirmDeleteCollectionItem}>Delete {deleteConfirmTarget?.kind ?? 'item'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogContent className="changes-dialog">
          <DialogHeader><DialogTitle>{commitDialogView === 'changes' ? 'Commit changes' : 'Commit history'}</DialogTitle><DialogDescription>{commitDialogView === 'changes' ? 'Stage the workspace changes you want in this commit. Commit locally, then push to share them with your team.' : activeWorkspace?.cloudId ? 'Browse local and cloud commits. Select a commit to inspect its changed items and diff.' : 'Browse commits saved on this device. Connect this workspace to cloud to see your team’s commits.'}</DialogDescription></DialogHeader>
          <div className="commit-view-tabs" role="tablist" aria-label="Workspace changes and history">
            <button type="button" role="tab" aria-selected={commitDialogView === 'changes'} disabled={Boolean(isReadOnly)} onClick={() => setCommitDialogView('changes')}>Changes <span>{workspaceChanges.length}</span></button>
            <button type="button" role="tab" aria-selected={commitDialogView === 'history'} onClick={() => { setCommitDialogView('history'); setSelectedHistoryCommitId(''); setSelectedHistoryChangeId('') }}>History <span>{historyCommits.length}</span></button>
          </div>
          {commitDialogView === 'changes' ? <form className="changes-layout" onSubmit={saveCommit}>
            <div className="changes-sidebar changes-sidebar-commit">
              <label htmlFor="commit-message">Commit message</label>
              <Input id="commit-message" autoFocus required maxLength={200} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="e.g. Add billing endpoints" />
              <div className="changes-list-scroll">
                <section className="change-list-section">
                  <div className="change-list-heading"><strong>Staged changes</strong><span>{stagedChanges.length}</span><button type="button" className="text-action" onClick={() => { setStagedSnapshot(null); setStagedVariables(null) }} disabled={!stagedChanges.length}>Unstage all</button></div>
                  {stagedChanges.length ? stagedChanges.map((change) => <ChangeRow key={`staged-${change.id}`} change={change} selected={selectedChange?.id === change.id} onSelect={() => setSelectedChangeId(change.id)} actionLabel="Unstage" onAction={() => stageChange(change, false)} />) : <p className="change-empty">Stage your changes to commit them.</p>}
                </section>
                <section className="change-list-section">
                  <div className="change-list-heading"><strong>Changes</strong><span>{unstagedChanges.length}</span><button type="button" className="text-action" onClick={() => stageChanges(unstagedChanges, true)} disabled={!unstagedChanges.length}>Stage all</button></div>
                  {unstagedChanges.length ? unstagedChanges.map((change) => <ChangeRow key={`unstaged-${change.id}`} change={change} selected={selectedChange?.id === change.id} onSelect={() => setSelectedChangeId(change.id)} actionLabel="Stage" onAction={() => stageChange(change, true)} />) : <p className="change-empty">No unstaged changes.</p>}
                </section>
              </div>
              <div className="changes-sidebar-footer"><Button type="submit" disabled={!commitMessage.trim() || !stagedChanges.length}>Commit</Button></div>
            </div>
            <section className="diff-view" aria-label="Selected change diff">
              {selectedChange ? <>
                <header className="diff-file-header"><span className={`change-badge change-${selectedChange.status}`}>{changeStatusCode(selectedChange.status)}</span><strong title={selectedChange.name}>{selectedChange.name}</strong><span>{changeStatusText(selectedChange.status)}</span></header>
                <div className="diff-column-headings"><span>Previous</span><span>Working tree</span></div>
                <div className="diff-scroll" role="region" aria-label={`Diff for ${selectedChange.name}`}>
                  {diffRows.map((row, index) => <div className="diff-row" key={`${row.kind}-${row.leftLine ?? 'x'}-${row.rightLine ?? 'x'}-${index}`}>
                    <div className={`diff-cell ${row.kind === 'removed' ? 'diff-cell-removed' : ''}`}><span className="diff-gutter">{row.leftLine ?? ''}</span><code>{row.leftText || ' '}</code></div>
                    <div className={`diff-cell ${row.kind === 'added' ? 'diff-cell-added' : ''}`}><span className="diff-gutter">{row.rightLine ?? ''}</span><code>{row.rightText || ' '}</code></div>
                  </div>)}
                  {diffRows.length > 0 && diffRows.every((row) => row.kind === 'same') && <p className="diff-note">No content changes. This item moved within the workspace.</p>}
                </div>
              </> : <div className="diff-empty">Select a changed item to compare it.</div>}
            </section>
          </form>
          : <div className="changes-layout history-layout">
            <div className="changes-sidebar history-sidebar">
              <section className="change-list-section">
                <div className="change-list-heading"><strong>Commits</strong><span>{historyCommits.length}</span></div>
                {historyLoading && <p className="change-empty" role="status">Loading cloud history…</p>}
                {historyError && <p className="history-error" role="status">Cloud history could not load: {historyError}. Local commits are still shown.</p>}
                {!historyCommits.length && !historyLoading && <p className="change-empty">No commits yet. Make a change, stage it, and commit to start the history.</p>}
                {historyCommits.map((commit) => {
                  const status = commit.source === 'cloud' ? (localCommitIds.has(commit.id) ? 'Pushed' : 'Cloud') : commit.pushed ? 'Pushed' : 'Local'
                  return <button key={commit.id} type="button" className={cn('history-commit-row', selectedHistoryCommit?.id === commit.id && 'history-commit-row-selected')} aria-pressed={selectedHistoryCommit?.id === commit.id} onClick={() => { setSelectedHistoryCommitId(commit.id); setSelectedHistoryChangeId(''); setHistoryDetailError('') }}>
                    <span className={`history-commit-state history-commit-${status.toLowerCase()}`}>{status}</span>
                    <span className="history-commit-copy"><strong title={commit.message}>{commit.message}</strong><small>{new Date(commit.createdAt).toLocaleString()}</small></span>
                  </button>
                })}
              </section>
              {selectedHistoryCommit && <section className="change-list-section" aria-busy={historyDetailLoading}>
                <div className="change-list-heading"><strong>Changed items</strong><span>{historySnapshotsReady ? historyChanges.length : '…'}</span></div>
                {historySnapshotsReady && historyChanges.length ? historyChanges.map((change) => <HistoryChangeRow key={change.id} change={change} selected={selectedHistoryChange?.id === change.id} onSelect={() => setSelectedHistoryChangeId(change.id)} />) : historySnapshotsReady ? <p className="change-empty">This commit has no visible content changes.</p> : historyDetailError ? <p className="history-error" role="status">Commit details could not load: {historyDetailError}</p> : <p className="change-empty" role="status">Loading commit details…</p>}
              </section>}
            </div>
            <section className="diff-view" aria-label="Selected commit diff">
              {selectedHistoryCommit && selectedHistoryChange ? <>
                <header className="diff-file-header"><span className={`change-badge change-${selectedHistoryChange.status}`}>{changeStatusCode(selectedHistoryChange.status)}</span><strong title={selectedHistoryChange.name}>{selectedHistoryChange.name}</strong><span>{changeStatusText(selectedHistoryChange.status)}</span></header>
                <div className="diff-column-headings"><span>Parent version</span><span>{selectedHistoryCommit.message}</span></div>
                <div className="diff-scroll" role="region" aria-label={`Commit diff for ${selectedHistoryChange.name}`}>
                  {historyDiffRows.map((row, index) => <div className="diff-row" key={`${row.kind}-${row.leftLine ?? 'x'}-${row.rightLine ?? 'x'}-${index}`}>
                    <div className={`diff-cell ${row.kind === 'removed' ? 'diff-cell-removed' : ''}`}><span className="diff-gutter">{row.leftLine ?? ''}</span><code>{row.leftText || ' '}</code></div>
                    <div className={`diff-cell ${row.kind === 'added' ? 'diff-cell-added' : ''}`}><span className="diff-gutter">{row.rightLine ?? ''}</span><code>{row.rightText || ' '}</code></div>
                  </div>)}
                </div>
              </> : <div className="diff-empty">{selectedHistoryCommit && historyDetailError ? `Could not load commit details: ${historyDetailError}` : selectedHistoryCommit && !historySnapshotsReady ? 'Loading selected commit…' : selectedHistoryCommit ? 'Select a changed item to view its diff.' : historyLoading && !historyCommits.length ? 'Loading cloud commit history…' : historyCommits.length ? 'Select a commit to view its changed items.' : 'Commit history will appear here after your first commit.'}</div>}
            </section>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingMerge} onOpenChange={(open) => { if (!open) setPendingMerge(null) }}>
        <DialogContent className="merge-dialog">
          <DialogHeader><DialogTitle>Resolve workspace conflicts</DialogTitle><DialogDescription>Choose which version to keep for each item changed both locally and in the cloud.</DialogDescription></DialogHeader>
          <div className="merge-conflicts">
            {pendingMerge?.conflicts.map((conflict) => <section key={conflict.id} className="merge-conflict">
              <strong>{conflict.local?.name ?? conflict.remote?.name ?? 'Deleted item'}</strong>
              <div className="merge-choices">
                <label><input type="radio" name={`merge-${conflict.id}`} checked={mergeChoices[conflict.id] === 'local'} onChange={() => setMergeChoices((current) => ({ ...current, [conflict.id]: 'local' }))} /><span>Keep local{conflict.local ? `: ${conflict.local.name}` : ' (deleted)'}</span></label>
                <label><input type="radio" name={`merge-${conflict.id}`} checked={mergeChoices[conflict.id] === 'remote'} onChange={() => setMergeChoices((current) => ({ ...current, [conflict.id]: 'remote' }))} /><span>Keep cloud{conflict.remote ? `: ${conflict.remote.name}` : ' (deleted)'}</span></label>
              </div>
            </section>)}
            {pendingMerge?.variableConflict && <section className="merge-conflict">
              <strong>Workspace variables</strong>
              <div className="merge-choices">
                <label><input type="radio" name={`merge-${workspaceVariablesChangeId}`} checked={mergeChoices[workspaceVariablesChangeId] === 'local'} onChange={() => setMergeChoices((current) => ({ ...current, [workspaceVariablesChangeId]: 'local' }))} /><span>Keep local variable definitions and shared values</span></label>
                <label><input type="radio" name={`merge-${workspaceVariablesChangeId}`} checked={mergeChoices[workspaceVariablesChangeId] === 'remote'} onChange={() => setMergeChoices((current) => ({ ...current, [workspaceVariablesChangeId]: 'remote' }))} /><span>Keep cloud variable definitions and shared values</span></label>
              </div>
            </section>}
          </div>
          <Button onClick={() => void applyMergeResolution()} disabled={!pendingMerge || pendingMerge.conflicts.some((item) => !mergeChoices[item.id]) || Boolean(pendingMerge?.variableConflict && !mergeChoices[workspaceVariablesChangeId])}>Save merge</Button>
        </DialogContent>
      </Dialog>
      {syncStatus && <div className="sync-toast" role="status">{syncStatus}</div>}
    </main>
  )
}

function appendToFolder(folder: Folder, targetId: string, item: TreeNode): Folder {
  if (folder.id === targetId) return { ...folder, children: [...folder.children, item] }
  return { ...folder, children: folder.children.map((child) => isFolder(child) ? appendToFolder(child, targetId, item) : child) }
}

function firstRequestId(nodes: TreeNode[]): string {
  for (const node of nodes) {
    if (isRequest(node)) return node.id
    const nested = firstRequestId(node.children)
    if (nested) return nested
  }
  return ''
}

function ParamsEditor({ request, readOnly, suggestions, onVariableClick, onChange }: { request: SavedRequest; readOnly: boolean; suggestions: VariableSuggestion[]; onVariableClick: (name: string, sourceValue: string) => void; onChange: (patch: Partial<SavedRequest>) => void }) {
  const params = request.params ?? []
  const [showDescriptions, setShowDescriptions] = useState(false)
  const updateParam = (id: string, patch: Partial<ParamField>) => onChange({ params: params.map((param) => param.id === id ? { ...param, ...patch } : param) })
  const addParam = () => onChange({ params: [...params, { id: crypto.randomUUID(), name: '', value: '', enabled: true }] })

  return <div className="params-editor">
    <div className="params-toolbar">
      <Button type="button" variant="ghost" size="sm" disabled={readOnly} onClick={addParam}>＋ Add</Button>
      <Button type="button" variant="ghost" size="sm" disabled={readOnly || params.length === 0} onClick={() => onChange({ params: [] })}>Delete all</Button>
      <Button type="button" variant="ghost" size="sm" aria-pressed={showDescriptions} onClick={() => setShowDescriptions((shown) => !shown)}>Description</Button>
      <span className="params-count">{params.length} params</span>
    </div>
    <div className="params-table" role="table" aria-label="Query parameters">
      <div className={cn('params-heading', showDescriptions && 'params-heading-with-description')} role="row"><span aria-hidden="true" /><span role="columnheader">Parameter</span><span role="columnheader">Value</span>{showDescriptions && <span role="columnheader">Description</span>}<span aria-hidden="true" /></div>
      {params.map((param, index) => <div className="params-entry" key={param.id}>
        <div className={cn('params-row', showDescriptions && 'params-row-with-description')} role="row">
          <input aria-label={`Enable parameter ${index + 1}`} className="param-enabled" type="checkbox" checked={param.enabled} disabled={readOnly} onChange={(event) => updateParam(param.id, { enabled: event.target.checked })} />
          <VariableInput aria-label={`Parameter name ${index + 1}`} value={param.name} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} placeholder="Parameter" onValueChange={(value) => updateParam(param.id, { name: value })} />
          <VariableInput aria-label={`Parameter value ${index + 1}`} value={param.value} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} placeholder="Value" onValueChange={(value) => updateParam(param.id, { value })} />
          {showDescriptions && <DebouncedInput aria-label={`Description for parameter ${index + 1}`} value={param.description ?? ''} readOnly={readOnly} placeholder="Description" onValueChange={(value) => updateParam(param.id, { description: value })} />}
          <Button type="button" variant="ghost" size="sm" className="param-remove" aria-label={`Delete parameter ${index + 1}`} disabled={readOnly} onClick={() => onChange({ params: params.filter((item) => item.id !== param.id) })}>×</Button>
        </div>
      </div>)}
    </div>
  </div>
}

function AuthEditor({ request, readOnly, suggestions, onVariableClick, onChange }: { request: SavedRequest; readOnly: boolean; suggestions: VariableSuggestion[]; onVariableClick: (name: string, sourceValue: string) => void; onChange: (patch: Partial<SavedRequest>) => void }) {
  const auth = request.auth ?? { type: 'none' as const }
  const setAuthType = (type: string) => {
    if (type === 'bearer') onChange({ auth: { type, token: '' } })
    else if (type === 'basic') onChange({ auth: { type, username: '', password: '' } })
    else if (type === 'api-key') onChange({ auth: { type, name: '', value: '', location: 'header' } })
    else onChange({ auth: { type: 'none' } })
  }
  const updateAuth = (patch: Partial<Extract<RequestAuth, { type: 'bearer' | 'basic' | 'api-key' }>>) => {
    if (auth.type !== 'none') onChange({ auth: { ...auth, ...patch } as RequestAuth })
  }

  return <div className="auth-editor">
    <label className="auth-type-label"><span>Authorization type</span>
      <Select value={auth.type} onValueChange={setAuthType} disabled={readOnly}>
        <SelectTrigger aria-label="Authorization type" className="auth-type-select"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="none">None</SelectItem><SelectItem value="api-key">API Key</SelectItem><SelectItem value="basic">Basic Auth</SelectItem><SelectItem value="bearer">Bearer Token</SelectItem></SelectContent>
      </Select>
    </label>
    {auth.type === 'bearer' && <label className="auth-field"><span>Token</span><VariableInput aria-label="Bearer token" type="password" autoComplete="off" value={auth.token} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => updateAuth({ token: value })} placeholder="Enter token" /></label>}
    {auth.type === 'basic' && <div className="auth-field-grid"><label className="auth-field"><span>Username</span><VariableInput aria-label="Basic auth username" autoComplete="off" value={auth.username} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => updateAuth({ username: value })} placeholder="Username" /></label><label className="auth-field"><span>Password</span><VariableInput aria-label="Basic auth password" type="password" autoComplete="new-password" value={auth.password} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => updateAuth({ password: value })} placeholder="Password" /></label></div>}
    {auth.type === 'api-key' && <div className="auth-field-grid"><label className="auth-field"><span>Key</span><VariableInput aria-label="API key name" autoComplete="off" value={auth.name} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => updateAuth({ name: value })} placeholder="e.g. X-API-Key" /></label><label className="auth-field"><span>Value</span><VariableInput aria-label="API key value" type="password" autoComplete="off" value={auth.value} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => updateAuth({ value })} placeholder="Enter API key" /></label><label className="auth-field"><span>Add to</span><Select value={auth.location} onValueChange={(location) => updateAuth({ location: location as 'header' | 'query' })} disabled={readOnly}><SelectTrigger aria-label="API key location" className="auth-location-select"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="header">Header</SelectItem><SelectItem value="query">Query params</SelectItem></SelectContent></Select></label></div>}
    {auth.type === 'none' && <p className="auth-help">This request will not add an authorization header.</p>}
    {auth.type !== 'none' && <p className="auth-help">Credentials are applied when the request is sent and override matching authorization headers.</p>}
  </div>
}

type HeaderEditorProps = {
  request: SavedRequest
  readOnly: boolean
  suggestions: VariableSuggestion[]
  onVariableClick: (name: string, sourceValue: string) => void
  onChange: (patch: Partial<SavedRequest>) => void
}

function HeaderEditorView({ request, readOnly, suggestions, onVariableClick, onChange }: HeaderEditorProps) {
  const headers = request.headers ?? []
  const [showDescriptions, setShowDescriptions] = useState(false)
  const [draggedHeaderId, setDraggedHeaderId] = useState<string | null>(null)
  const updateHeader = (id: string, patch: Partial<HeaderField>) => onChange({ headers: headers.map((header) => header.id === id ? { ...header, ...patch } : header) })
  const addHeader = () => onChange({ headers: [...headers, { id: crypto.randomUUID(), name: '', value: '', enabled: true }] })
  const removeHeader = (id: string) => onChange({ headers: headers.filter((header) => header.id !== id) })
  const moveHeader = (targetId: string) => {
    if (!draggedHeaderId || draggedHeaderId === targetId) return
    const reordered = [...headers]
    const sourceIndex = reordered.findIndex((header) => header.id === draggedHeaderId)
    const targetIndex = reordered.findIndex((header) => header.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [header] = reordered.splice(sourceIndex, 1)
    reordered.splice(targetIndex, 0, header)
    onChange({ headers: reordered })
    setDraggedHeaderId(null)
  }
  const enabledHeader = (name: string) => headers.find((header) => header.enabled && header.name.trim().toLowerCase() === name.toLowerCase())
  const mode = request.bodyMode ?? (request.body.trim() ? 'json' : 'none')
  const generated: Array<{ name: string; value: string }> = []
  const customAccept = enabledHeader('Accept')
  const customHost = enabledHeader('Host')
  const customAgent = enabledHeader('User-Agent')
  const customContentType = enabledHeader('Content-Type')

  if (!customAccept) generated.push({ name: 'Accept', value: '*/*' })
  if (!customHost) generated.push({ name: 'Host', value: '<calculated at runtime>' })
  if (!customAgent) generated.push({ name: 'User-Agent', value: 'API-Documentation/0.1.0' })
  if (mode !== 'none') {
    const canSendBody = !['GET', 'HEAD'].includes(request.method.toUpperCase())
    const contentType = mode === 'form-data' ? canSendBody ? 'multipart/form-data; boundary=<generated at send time>' : 'multipart/form-data'
      : mode === 'urlencoded' ? 'application/x-www-form-urlencoded;charset=UTF-8'
        : mode === 'file' ? request.bodyMimeType || 'application/octet-stream'
          : mode === 'other' ? request.bodyMimeType || 'text/plain'
            : mode === 'graphql' || mode === 'json' ? 'application/json'
              : mode === 'xml' ? 'application/xml'
                : mode === 'yaml' ? 'application/yaml'
                  : mode === 'edn' ? 'application/edn' : 'text/plain'
    if (!customContentType || mode === 'form-data') generated.push({ name: 'Content-Type', value: mode === 'form-data' ? contentType : customContentType ? customContentType.value : contentType })
  }
  const auth = request.auth ?? { type: 'none' as const }
  if (auth.type === 'bearer' && auth.token) generated.push({ name: 'Authorization', value: `Bearer ${'•'.repeat(Math.min(auth.token.length, 12))}` })
  if (auth.type === 'basic' && (auth.username || auth.password)) generated.push({ name: 'Authorization', value: 'Basic <generated from credentials>' })
  if (auth.type === 'api-key' && auth.location === 'header' && auth.name && auth.value) generated.push({ name: auth.name, value: '•'.repeat(Math.min(auth.value.length, 12)) })

  return <div className="headers-editor">
    <div className="headers-toolbar">
      <Button type="button" variant="ghost" size="sm" disabled={readOnly} onClick={addHeader}>＋ Add</Button>
      <Button type="button" variant="ghost" size="sm" disabled={readOnly || headers.length === 0} onClick={() => onChange({ headers: [] })}>Delete all</Button>
      <Button type="button" variant="ghost" size="sm" aria-pressed={showDescriptions} onClick={() => setShowDescriptions((shown) => !shown)}>Description</Button>
      <span className="headers-count">{headers.length} custom</span>
    </div>
    <div className="headers-table" role="table" aria-label="Request headers">
      <div className="headers-heading" role="row"><span aria-hidden="true" /><span aria-hidden="true" /><span role="columnheader">Header</span><span role="columnheader">Value</span><span aria-hidden="true" /></div>
      {headers.map((header, index) => <div className="headers-entry" key={header.id} onDragOver={(event) => { if (draggedHeaderId) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); moveHeader(header.id) }}>
        <div className="headers-row" role="row">
          <button type="button" className="header-drag-handle" draggable={!readOnly} aria-label={`Reorder header ${index + 1}`} onDragStart={(event) => { setDraggedHeaderId(header.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', header.id) }} onDragEnd={() => setDraggedHeaderId(null)} disabled={readOnly}>⠿</button>
          <input aria-label={`Enable header ${index + 1}`} className="header-enabled" type="checkbox" checked={header.enabled} disabled={readOnly} onChange={(event) => updateHeader(header.id, { enabled: event.target.checked })} />
          <VariableInput aria-label={`Header name ${index + 1}`} value={header.name} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} placeholder="Header" onValueChange={(value) => updateHeader(header.id, { name: value })} />
          <VariableInput aria-label={`Header value ${index + 1}`} value={header.value} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} placeholder="Value" onValueChange={(value) => updateHeader(header.id, { value })} />
          <Button type="button" variant="ghost" size="sm" className="header-remove" aria-label={`Delete header ${index + 1}`} disabled={readOnly} onClick={() => removeHeader(header.id)}>×</Button>
        </div>
        {showDescriptions && <DebouncedInput className="header-description" aria-label={`Description for header ${index + 1}`} value={header.description ?? ''} readOnly={readOnly} placeholder="Description" onValueChange={(value) => updateHeader(header.id, { description: value })} />}
      </div>)}
      <div className="headers-generated-label">Generated at send time</div>
      {generated.map((header) => <div className="headers-generated-row" role="row" key={header.name}>
        <span aria-hidden="true" />
        <input className="header-enabled" type="checkbox" checked disabled aria-label={`${header.name} is generated`} />
        <span className="header-generated-name">{header.name}</span>
        <span className="header-generated-value">{header.value}</span>
        <span className="header-generated-status">Auto</span>
      </div>)}
    </div>
    {mode === 'form-data' && <p className="headers-help">Multipart Content-Type includes a boundary generated when the request is sent.</p>}
    {customContentType && mode !== 'form-data' && <p className="headers-help">This custom Content-Type overrides the value inferred from the body type.</p>}
  </div>
}

const HeaderEditor = memo(HeaderEditorView, (previous, next) =>
  previous.request.id === next.request.id &&
  previous.request.headers === next.request.headers &&
  previous.request.bodyMode === next.request.bodyMode &&
  previous.request.body === next.request.body &&
  previous.request.bodyMimeType === next.request.bodyMimeType &&
  previous.request.method === next.request.method &&
  previous.request.auth === next.request.auth &&
  previous.readOnly === next.readOnly &&
  previous.suggestions === next.suggestions
)

const bodyModeLabels: Record<BodyMode, string> = {
  'form-data': 'Form Data',
  urlencoded: 'Form URL Encoded',
  graphql: 'GraphQL',
  json: 'JSON',
  xml: 'XML',
  yaml: 'YAML',
  edn: 'EDN',
  text: 'Plain Text',
  other: 'Other',
  file: 'File',
  none: 'No Body'
}

function BodyEditor({ request, readOnly, suggestions, onVariableClick, onChange }: { request: SavedRequest; readOnly: boolean; suggestions: VariableSuggestion[]; onVariableClick: (name: string, sourceValue: string) => void; onChange: (patch: Partial<SavedRequest>) => void }) {
  const [fileError, setFileError] = useState('')
  const mode = request.bodyMode ?? (request.body.trim() ? 'json' : 'none')
  const fields = request.bodyFields ?? []
  const updateField = (id: string, patch: Partial<BodyField>) => onChange({ bodyFields: fields.map((field) => field.id === id ? { ...field, ...patch } : field) })

  async function chooseFile(onSelected: (file: { path: string; name: string }) => void) {
    setFileError('')
    try {
      const file = await window.apiDesktop.selectFile()
      if (file) onSelected(file)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : 'Could not select a file.')
    }
  }

  function addField() {
    onChange({ bodyFields: [...fields, { id: crypto.randomUUID(), name: '', value: '', enabled: true, type: 'text' }] })
  }

  const help = mode === 'form-data' ? 'Multipart encoding is generated automatically. File attachments stay on this device.'
    : mode === 'urlencoded' ? 'Enabled keys and values are URL encoded before sending.'
      : mode === 'graphql' ? 'The query and variables are sent as a JSON GraphQL request.'
        : mode === 'file' ? 'The selected file is sent as the raw request body.'
          : mode === 'none' ? 'This request will be sent without a body.'
            : `Content-Type: ${mode === 'other' ? request.bodyMimeType || 'text/plain' : bodyContentType(mode)}`

  return <div className="body-composer">
    <div className="body-toolbar">
      <Select value={mode} onValueChange={(value) => onChange({ bodyMode: value as BodyMode })} disabled={readOnly}>
        <SelectTrigger aria-label="Body type" className="body-mode-select"><SelectValue /></SelectTrigger>
        <SelectContent>{bodyModes.map((item) => <SelectItem key={item} value={item}>{bodyModeLabels[item]}</SelectItem>)}</SelectContent>
      </Select>
      <span className="body-mode-help">{help}</span>
    </div>

    {(mode === 'form-data' || mode === 'urlencoded') && <div className="body-fields">
      <div className={cn('body-fields-heading', mode === 'urlencoded' && 'body-fields-heading-urlencoded')}><span aria-hidden="true" /><span>Key</span>{mode === 'form-data' && <span>Type</span>}<span>{mode === 'form-data' ? 'Value or file' : 'Value'}</span><span aria-hidden="true" /></div>
      {fields.map((field, index) => <div className={cn('body-field-row', mode === 'urlencoded' && 'body-field-row-urlencoded')} key={field.id}>
        <input aria-label={`Enable field ${index + 1}`} className="body-field-enabled" type="checkbox" checked={field.enabled} disabled={readOnly} onChange={(event) => updateField(field.id, { enabled: event.target.checked })} />
        <VariableInput aria-label={`Body key ${index + 1}`} value={field.name} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} placeholder="Key" onValueChange={(value) => updateField(field.id, { name: value })} />
        {mode === 'form-data' && <Select value={field.type} onValueChange={(value) => updateField(field.id, { type: value as BodyField['type'] })} disabled={readOnly}><SelectTrigger aria-label={`Field type ${index + 1}`} className="body-field-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="text">Text</SelectItem><SelectItem value="file">File</SelectItem></SelectContent></Select>}
        {mode === 'form-data' && field.type === 'file' ? <div className="body-file-control"><Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => void chooseFile((file) => updateField(field.id, { filePath: file.path, fileName: file.name }))}>Choose file</Button><span title={field.filePath}>{field.filePath ? field.fileName || 'Selected file' : field.fileName ? `${field.fileName} · choose on this device` : 'No file selected'}</span></div> : <VariableInput aria-label={`Body value ${index + 1}`} value={field.value} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} placeholder="Value" onValueChange={(value) => updateField(field.id, { value })} />}
        <Button type="button" variant="ghost" size="sm" className="body-remove-field" disabled={readOnly} onClick={() => onChange({ bodyFields: fields.filter((item) => item.id !== field.id) })}>Remove</Button>
      </div>)}
      <Button type="button" variant="outline" size="sm" className="body-add-field" disabled={readOnly} onClick={addField}>Add field</Button>
    </div>}

    {mode === 'graphql' && <div className="body-raw-fields"><label><span>Query</span><VariableTextarea className="code-field" aria-label="GraphQL query" value={request.body} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => onChange({ body: value })} placeholder="query { ... }" /></label><label><span>Variables (JSON)</span><VariableTextarea className="code-field body-variables" aria-label="GraphQL variables" value={request.bodyVariables ?? '{}'} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => onChange({ bodyVariables: value })} placeholder="{}" /></label></div>}

    {['json', 'xml', 'yaml', 'edn', 'text', 'other'].includes(mode) && <div className="body-raw-fields">
      {mode === 'other' && <label className="body-mime-field"><span>Content-Type</span><VariableInput aria-label="Body content type" value={request.bodyMimeType ?? 'text/plain'} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => onChange({ bodyMimeType: value })} placeholder="application/octet-stream" /></label>}
      <VariableTextarea className="code-field" aria-label={`${bodyModeLabels[mode]} request body`} value={request.body} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => onChange({ body: value })} placeholder={mode === 'json' ? '{\n  \n}' : `Enter ${bodyModeLabels[mode]} body`} />
    </div>}

    {mode === 'file' && <div className="body-file-picker">
      <Button type="button" variant="outline" disabled={readOnly} onClick={() => void chooseFile((file) => onChange({ bodyPath: file.path, bodyFileName: file.name }))}>Choose file</Button>
      <span title={request.bodyPath}>{request.bodyPath ? request.bodyFileName || 'Selected file' : request.bodyFileName ? `${request.bodyFileName} · choose on this device` : 'No file selected'}</span>
      <label><span>Content-Type</span><VariableInput aria-label="File content type" value={request.bodyMimeType ?? 'application/octet-stream'} suggestions={suggestions} onVariableClick={onVariableClick} readOnly={readOnly} onValueChange={(value) => onChange({ bodyMimeType: value })} /></label>
      <p className="body-local-file-note">The file stays on this device. Teammates need to select their own copy after pulling the request.</p>
    </div>}

    {fileError && <p className="body-file-error" role="alert">{fileError}</p>}
  </div>
}

function bodyContentType(mode: BodyMode): string {
  switch (mode) {
    case 'graphql': case 'json': return 'application/json'
    case 'xml': return 'application/xml'
    case 'yaml': return 'application/yaml'
    case 'edn': return 'application/edn'
    default: return 'text/plain'
  }
}

function ChangeRow({ change, selected, onSelect, actionLabel, onAction }: { change: WorkspaceChange; selected: boolean; onSelect: () => void; actionLabel: string; onAction: () => void }) {
  return <div className={cn('change-row', selected && 'change-row-selected')}>
    <span className={`change-badge change-${change.status}`}>{changeStatusCode(change.status)}</span>
    <button type="button" className="change-name" aria-pressed={selected} onClick={onSelect}>{change.name}</button>
    <button type="button" className="text-action" onClick={onAction}>{actionLabel}</button>
  </div>
}

function HistoryChangeRow({ change, selected, onSelect }: { change: WorkspaceChange; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={cn('history-change-row', selected && 'history-change-row-selected')} aria-pressed={selected} onClick={onSelect}>
    <span className={`change-badge change-${change.status}`}>{changeStatusCode(change.status)}</span>
    <span>{change.name}</span>
    <small>{changeStatusText(change.status)}</small>
  </button>
}

function changeStatusCode(status?: WorkspaceChange['status']): string {
  return status === 'added' ? 'U' : status === 'deleted' ? 'D' : 'M'
}

function changeStatusText(status?: WorkspaceChange['status']): string {
  return status === 'added' ? 'Untracked' : status === 'deleted' ? 'Deleted' : 'Modified'
}

function StateMessage({ title, description, error = false }: { title: string; description: string; error?: boolean }) {
  return <div className={cn('state-message', error && 'state-error')}><strong>{title}</strong><p>{description}</p></div>
}

const AuthDialog = memo(function AuthDialog({ showTrigger, onBeginSignIn, openRequest, initialError, onOpen }: {
  showTrigger: boolean
  onBeginSignIn: () => Promise<void>
  openRequest: number
  initialError: string
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (openRequest > 0) setOpen(true)
  }, [openRequest])
  useEffect(() => { if (!open) setPending(false) }, [open])
  useEffect(() => { if (!showTrigger && open) setOpen(false) }, [showTrigger, open])

  async function startSignIn() {
    setError('')
    setPending(true)
    try {
      await onBeginSignIn()
    } catch (reason) {
      setPending(false)
      setError(reason instanceof Error ? reason.message : 'Could not open the browser for sign-in.')
    }
  }

  function openDialog() {
    onOpen()
    setError('')
    setOpen(true)
  }

  return <>
    {showTrigger && <Button variant="outline" size="sm" onClick={openDialog}>Sign in</Button>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Sign in</DialogTitle><DialogDescription>Sign in with your browser to sync and share workspaces.</DialogDescription></DialogHeader>
        <div className="dialog-form">
          {(error || initialError) && <p className="dialog-error" role="alert">{error || initialError}</p>}
          {pending
            ? <p className="auth-pending" role="status">Waiting for you to finish signing in in your browser…</p>
            : <Button type="button" onClick={() => void startSignIn()}>Sign in with browser</Button>}
          {pending && <button className="dialog-link" type="button" onClick={() => void startSignIn()}>Didn't open? Try again</button>}
        </div>
      </DialogContent>
    </Dialog>
  </>
})

export default App
