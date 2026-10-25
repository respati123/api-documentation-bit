import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

type BodyMode = 'form-data' | 'urlencoded' | 'graphql' | 'json' | 'xml' | 'yaml' | 'edn' | 'text' | 'other' | 'file' | 'none'
type HeaderField = { id: string; name: string; value: string; enabled: boolean; description?: string }
type ParamField = { id: string; name: string; value: string; enabled: boolean; description?: string }
type BodyField = { id: string; name: string; value: string; enabled: boolean; type: 'text' | 'file'; filePath?: string; fileName?: string }
type RequestAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'api-key'; name: string; value: string; location: 'header' | 'query' }
type ResponseContent = { id: string; mediaType: string; schema: string; example: string }
type ResponseDefinition = { id: string; statusCode: string; description: string; content: ResponseContent[] }
type SyncRequest = {
  id: string
  kind: 'request'
  name: string
  method: string
  url: string
  body: string
  bodyMode?: BodyMode
  bodyFields?: BodyField[]
  bodyVariables?: string
  bodyMimeType?: string
  bodyPath?: string
  bodyFileName?: string
  headers?: HeaderField[]
  params?: ParamField[]
  pathParams?: ParamField[]
  auth?: RequestAuth
  documentation?: string
  responses?: ResponseDefinition[]
  openApiSchemas?: Record<string, unknown>
  deprecated?: boolean
  deprecationReason?: string
}
type SyncFolder = { id: string; kind: 'folder'; name: string; children: SyncTreeNode[] }
type SyncTreeNode = SyncRequest | SyncFolder

type StoredWorkspace = {
  id: string
  cloudId: string | null
  name: string
  tree: SyncTreeNode[]
  role?: 'owner' | 'editor' | 'viewer' | null
  [key: string]: unknown
}

type CreateFolderOperation = { action: 'create_folder'; parentId: string | null; name: string }
type CreateRequestOperation = { action: 'create_request'; parentId: string | null; request: Partial<SyncRequest> & Pick<SyncRequest, 'name' | 'method' | 'url'> }
type UpdateRequestOperation = { action: 'update_request'; requestId: string; patch: Partial<SyncRequest> }
type RenameFolderOperation = { action: 'rename_folder'; folderId: string; name: string }
type MoveNodeOperation = { action: 'move_node'; nodeId: string; parentId: string | null; index?: number }
type DeprecateRequestOperation = { action: 'deprecate_request'; requestId: string; deprecated: boolean; reason?: string }
type DeleteNodeOperation = { action: 'delete_node'; nodeId: string }
type ChangeOperation = CreateFolderOperation | CreateRequestOperation | UpdateRequestOperation | RenameFolderOperation | MoveNodeOperation | DeprecateRequestOperation | DeleteNodeOperation

type PlannedChange = {
  id: string
  workspaceId: string
  sourceHash: string
  operations: ChangeOperation[]
  nextTree: SyncTreeNode[]
  summary: Array<{ action: string; target: string; before?: unknown; after?: unknown }>
  includesDelete: boolean
  expiresAt: number
}

const appName = 'api-documentation-bit'
const defaultAppData = process.platform === 'win32'
  ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
const dataDirectory = process.env.API_DOCS_USER_DATA_DIR || join(defaultAppData, appName)
const databasePath = join(dataDirectory, 'workspace.sqlite')
const plans = new Map<string, PlannedChange>()
let localDatabase: DatabaseSync | undefined

const bodyModes = ['form-data', 'urlencoded', 'graphql', 'json', 'xml', 'yaml', 'edn', 'text', 'other', 'file', 'none'] as const
const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().max(65536) }),
  z.object({ type: z.literal('basic'), username: z.string().max(8192), password: z.string().max(65536) }),
  z.object({ type: z.literal('api-key'), name: z.string().max(8192), value: z.string().max(65536), location: z.enum(['header', 'query']) })
])
const fieldSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(8192),
  value: z.string().max(65536),
  enabled: z.boolean().default(true),
  description: z.string().max(4096).optional()
})
const bodyFieldSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(8192),
  value: z.string().max(65536),
  enabled: z.boolean().default(true),
  type: z.enum(['text', 'file']).default('text'),
  fileName: z.string().max(1024).optional()
})
const responseContentSchema = z.object({
  id: z.string().optional(),
  mediaType: z.string().max(160),
  schema: z.string().max(1_000_000),
  example: z.string().max(1_000_000)
})
const responseDefinitionSchema = z.object({
  id: z.string().optional(),
  statusCode: z.string().trim().min(1).max(12),
  description: z.string().max(500),
  content: z.array(responseContentSchema).max(20)
})
const requestShape = {
  name: z.string().trim().min(1).max(160),
  method: z.string().trim().min(1).max(32),
  url: z.string().max(8192),
  body: z.string().max(1_000_000).optional(),
  bodyMode: z.enum(bodyModes).optional(),
  bodyFields: z.array(bodyFieldSchema).max(100).optional(),
  bodyVariables: z.string().max(1_000_000).optional(),
  bodyMimeType: z.string().max(1024).optional(),
  bodyFileName: z.string().max(1024).optional(),
  headers: z.array(fieldSchema).max(100).optional(),
  params: z.array(fieldSchema).max(100).optional(),
  pathParams: z.array(fieldSchema).max(100).optional(),
  auth: authSchema.optional(),
  documentation: z.string().max(100_000).optional(),
  responses: z.array(responseDefinitionSchema).max(100).optional(),
  deprecated: z.boolean().optional(),
  deprecationReason: z.string().max(4096).optional()
}

const operationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_folder'), parentId: z.string().nullable().default(null), name: z.string().trim().min(1).max(160) }),
  z.object({ action: z.literal('create_request'), parentId: z.string().nullable().default(null), request: z.object(requestShape).extend({ method: requestShape.method.transform((method) => method.toUpperCase()) }) }),
  z.object({ action: z.literal('update_request'), requestId: z.string().min(1), patch: z.object({
    ...requestShape,
    name: requestShape.name.optional(),
    method: requestShape.method.transform((method) => method.toUpperCase()).optional(),
    url: requestShape.url.optional()
  }).partial() }),
  z.object({ action: z.literal('rename_folder'), folderId: z.string().min(1), name: z.string().trim().min(1).max(160) }),
  z.object({ action: z.literal('move_node'), nodeId: z.string().min(1), parentId: z.string().nullable().default(null), index: z.number().int().min(0).optional() }),
  z.object({ action: z.literal('deprecate_request'), requestId: z.string().min(1), deprecated: z.boolean().default(true), reason: z.string().max(4096).optional() }),
  z.object({ action: z.literal('delete_node'), nodeId: z.string().min(1) })
])

function database(): DatabaseSync {
  if (!existsSync(databasePath)) {
    throw new Error(`Workspace database was not found at ${databasePath}. Open API Documentation once to create the local workspace.`)
  }
  if (!localDatabase) {
    localDatabase = new DatabaseSync(databasePath)
    localDatabase.exec('PRAGMA busy_timeout = 5000;')
  }
  return localDatabase
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function loadRawWorkspace(workspaceId: string): { raw: string; workspace: StoredWorkspace } {
  const row = database().prepare('SELECT data FROM workspaces WHERE id = ?').get(workspaceId) as { data: string } | undefined
  if (!row) throw new Error(`Workspace "${workspaceId}" was not found.`)
  const workspace = JSON.parse(row.data) as StoredWorkspace
  if (!Array.isArray(workspace.tree)) throw new Error('Workspace collection data is invalid.')
  return { raw: row.data, workspace }
}

function assertCanEdit(workspace: StoredWorkspace): void {
  if (workspace.role === 'viewer') throw new Error('This workspace is read-only for the current account.')
}

function isFolder(node: SyncTreeNode): node is SyncFolder { return node.kind === 'folder' }
function findNode(nodes: SyncTreeNode[], id: string): SyncTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    if (isFolder(node)) {
      const nested = findNode(node.children, id)
      if (nested) return nested
    }
  }
  return undefined
}

function findParentId(nodes: SyncTreeNode[], id: string, parentId: string | null = null): string | null | undefined {
  for (const node of nodes) {
    if (node.id === id) return parentId
    if (isFolder(node)) {
      const nested = findParentId(node.children, id, node.id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function insertNode(nodes: SyncTreeNode[], parentId: string | null, node: SyncTreeNode, index?: number): SyncTreeNode[] {
  if (parentId === null) {
    const next = [...nodes]
    next.splice(index === undefined ? next.length : Math.min(index, next.length), 0, node)
    return next
  }
  const insertInto = (siblings: SyncTreeNode[]): { nodes: SyncTreeNode[]; found: boolean } => {
    for (let position = 0; position < siblings.length; position += 1) {
      const child = siblings[position]
      if (!isFolder(child)) continue
      if (child.id === parentId) {
        const children = [...child.children]
        children.splice(index === undefined ? children.length : Math.min(index, children.length), 0, node)
        const next = [...siblings]
        next[position] = { ...child, children }
        return { nodes: next, found: true }
      }
      const nested = insertInto(child.children)
      if (nested.found) {
        const next = [...siblings]
        next[position] = { ...child, children: nested.nodes }
        return { nodes: next, found: true }
      }
    }
    return { nodes: siblings, found: false }
  }
  const result = insertInto(nodes)
  if (!result.found) throw new Error(`Parent folder "${parentId}" was not found.`)
  return result.nodes
}

function removeNode(nodes: SyncTreeNode[], id: string): { tree: SyncTreeNode[]; removed?: SyncTreeNode } {
  const directIndex = nodes.findIndex((node) => node.id === id)
  if (directIndex >= 0) {
    const next = [...nodes]
    const [removed] = next.splice(directIndex, 1)
    return { tree: next, removed }
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (!isFolder(node)) continue
    const result = removeNode(node.children, id)
    if (!result.removed) continue
    const next = [...nodes]
    next[index] = { ...node, children: result.tree }
    return { tree: next, removed: result.removed }
  }
  return { tree: nodes }
}

function updateNode(nodes: SyncTreeNode[], id: string, update: (node: SyncTreeNode) => SyncTreeNode): { tree: SyncTreeNode[]; found: boolean } {
  let found = false
  const tree = nodes.map((node) => {
    if (node.id === id) {
      found = true
      return update(node)
    }
    if (!isFolder(node)) return node
    const nested = updateNode(node.children, id, update)
    if (!nested.found) return node
    found = true
    return { ...node, children: nested.tree }
  })
  return { tree, found }
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = '<redacted>'
    if (url.password) url.password = '<redacted>'
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) url.searchParams.set(key, '<redacted>')
    }
    return url.toString()
  } catch { return value }
}

function isSensitiveName(value: string): boolean {
  return /authorization|cookie|token|secret|password|\bkey\b|api[-_]?key|client[-_]?secret/i.test(value)
}

function redactBody(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value)
    const redact = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(redact)
      if (!item || typeof item !== 'object') return item
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, isSensitiveName(key) ? '<redacted>' : redact(entry)]))
    }
    return JSON.stringify(redact(parsed), null, 2)
  } catch {
    return value.replace(/\b(authorization|cookie|token|secret|password|api[-_]?key|client[-_]?secret|key)\b\s*[:=]\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^,\r\n;}]+)/gi, '$1: <redacted>')
  }
}

function safeRequest(request: SyncRequest): SyncRequest {
  return {
    ...request,
    url: sanitizeUrl(request.url),
    body: redactBody(request.body),
    ...(request.documentation ? { documentation: redactBody(request.documentation) } : {}),
    ...(request.responses ? { responses: request.responses.map((response) => ({ ...response, content: response.content.map((content) => ({ ...content, example: redactBody(content.example) })) })) } : {}),
    ...(request.openApiSchemas ? { openApiSchemas: JSON.parse(redactBody(JSON.stringify(request.openApiSchemas))) as Record<string, unknown> } : {}),
    ...(request.headers ? { headers: request.headers.map((header) => ({ ...header, value: isSensitiveName(header.name) ? '<redacted>' : header.value })) } : {}),
    ...(request.params ? { params: request.params.map((param) => ({ ...param, value: isSensitiveName(param.name) ? '<redacted>' : param.value })) } : {}),
    ...(request.pathParams ? { pathParams: request.pathParams.map((param) => ({ ...param, value: isSensitiveName(param.name) ? '<redacted>' : param.value })) } : {}),
    ...(request.bodyFields ? { bodyFields: request.bodyFields.map((field) => ({ ...field, value: isSensitiveName(field.name) ? '<redacted>' : field.value, filePath: undefined })) } : {}),
    ...(request.auth?.type === 'bearer' ? { auth: { type: 'bearer', token: '<redacted>' } } : {}),
    ...(request.auth?.type === 'basic' ? { auth: { type: 'basic', username: '<redacted>', password: '<redacted>' } } : {}),
    ...(request.auth?.type === 'api-key' ? { auth: { ...request.auth, value: '<redacted>' } } : {}),
    bodyPath: undefined
  }
}

function safeTree(nodes: SyncTreeNode[]): unknown[] {
  return nodes.map((node) => isFolder(node)
    ? { id: node.id, kind: node.kind, name: node.name, children: safeTree(node.children) }
    : { id: node.id, kind: node.kind, name: node.name, method: node.method, url: sanitizeUrl(node.url), deprecated: node.deprecated === true })
}

function summarize(node: SyncTreeNode | undefined): unknown {
  if (!node) return undefined
  return isFolder(node)
    ? { id: node.id, kind: node.kind, name: node.name, childCount: node.children.length }
    : safeRequest(node)
}

function normalizeRequest(input: Partial<SyncRequest> & Pick<SyncRequest, 'name' | 'method' | 'url'>, existing?: SyncRequest): SyncRequest {
  const headers = input.headers ?? existing?.headers ?? []
  const params = input.params ?? existing?.params ?? []
  const pathParams = input.pathParams ?? existing?.pathParams ?? []
  const bodyFields = input.bodyFields ?? existing?.bodyFields ?? []
  const responses = input.responses ?? existing?.responses ?? []
  return {
    ...existing,
    ...input,
    id: existing?.id ?? input.id ?? randomUUID(),
    kind: 'request',
    name: input.name,
    method: input.method.toUpperCase(),
    url: input.url,
    body: input.body ?? existing?.body ?? '',
    headers: headers.map((item) => ({ ...item, id: item.id || randomUUID() })),
    params: params.map((item) => ({ ...item, id: item.id || randomUUID() })),
    pathParams: pathParams.map((item) => ({ ...item, id: item.id || randomUUID() })),
    bodyFields: bodyFields.map((item) => ({ ...item, id: item.id || randomUUID() })),
    responses: responses.map((response) => ({ ...response, id: response.id || randomUUID(), content: response.content.map((content) => ({ ...content, id: content.id || randomUUID() })) }))
  }
}

function collectSummary(tree: SyncTreeNode[], operation: ChangeOperation): { tree: SyncTreeNode[]; summary: PlannedChange['summary'][number] } {
  if (operation.action === 'create_folder') {
    const parent = operation.parentId ? findNode(tree, operation.parentId) : undefined
    if (operation.parentId && (!parent || !isFolder(parent))) throw new Error(`Parent folder "${operation.parentId}" was not found.`)
    const folder: SyncFolder = { id: randomUUID(), kind: 'folder', name: operation.name.trim(), children: [] }
    return { tree: insertNode(tree, operation.parentId, folder), summary: { action: operation.action, target: folder.name, after: summarize(folder) } }
  }
  if (operation.action === 'create_request') {
    const parent = operation.parentId ? findNode(tree, operation.parentId) : undefined
    if (operation.parentId && (!parent || !isFolder(parent))) throw new Error(`Parent folder "${operation.parentId}" was not found.`)
    const request = normalizeRequest(operation.request)
    return { tree: insertNode(tree, operation.parentId, request), summary: { action: operation.action, target: request.name, after: summarize(request) } }
  }
  if (operation.action === 'update_request') {
    const before = findNode(tree, operation.requestId)
    if (!before || isFolder(before)) throw new Error(`Request "${operation.requestId}" was not found.`)
    const updated = normalizeRequest({ ...before, ...operation.patch, name: operation.patch.name ?? before.name, method: operation.patch.method ?? before.method, url: operation.patch.url ?? before.url }, before)
    const result = updateNode(tree, operation.requestId, () => updated)
    return { tree: result.tree, summary: { action: operation.action, target: updated.name, before: summarize(before), after: summarize(updated) } }
  }
  if (operation.action === 'rename_folder') {
    const before = findNode(tree, operation.folderId)
    if (!before || !isFolder(before)) throw new Error(`Folder "${operation.folderId}" was not found.`)
    const result = updateNode(tree, operation.folderId, (node) => isFolder(node) ? { ...node, name: operation.name.trim() } : node)
    return { tree: result.tree, summary: { action: operation.action, target: operation.name.trim(), before: summarize(before), after: { ...(summarize(before) as object), name: operation.name.trim() } } }
  }
  if (operation.action === 'move_node') {
    const before = findNode(tree, operation.nodeId)
    if (!before) throw new Error(`Collection item "${operation.nodeId}" was not found.`)
    const parent = operation.parentId ? findNode(tree, operation.parentId) : undefined
    if (operation.parentId && (!parent || !isFolder(parent))) throw new Error(`Parent folder "${operation.parentId}" was not found.`)
    if (isFolder(before) && (before.id === operation.parentId || findNode(before.children, operation.parentId ?? '')?.kind === 'folder')) throw new Error('A folder cannot be moved inside itself or one of its descendants.')
    const oldParentId = findParentId(tree, before.id)
    const removed = removeNode(tree, before.id)
    if (!removed.removed) throw new Error(`Collection item "${operation.nodeId}" could not be moved.`)
    const next = insertNode(removed.tree, operation.parentId, removed.removed, operation.index)
    return { tree: next, summary: { action: operation.action, target: before.name, before: { parentId: oldParentId }, after: { parentId: operation.parentId, index: operation.index } } }
  }
  if (operation.action === 'deprecate_request') {
    const before = findNode(tree, operation.requestId)
    if (!before || isFolder(before)) throw new Error(`Request "${operation.requestId}" was not found.`)
    const updated = { ...before, deprecated: operation.deprecated, ...(operation.deprecated && operation.reason?.trim() ? { deprecationReason: operation.reason.trim() } : {}), ...(!operation.deprecated ? { deprecationReason: undefined } : {}) }
    const result = updateNode(tree, operation.requestId, () => updated)
    return { tree: result.tree, summary: { action: operation.action, target: updated.name, before: { deprecated: before.deprecated === true, deprecationReason: before.deprecationReason }, after: { deprecated: updated.deprecated, deprecationReason: updated.deprecationReason } } }
  }
  const before = findNode(tree, operation.nodeId)
  if (!before) throw new Error(`Collection item "${operation.nodeId}" was not found.`)
  const removed = removeNode(tree, operation.nodeId)
  return { tree: removed.tree, summary: { action: operation.action, target: before.name, before: summarize(before) } }
}

function requestMap(nodes: SyncTreeNode[]): SyncRequest[] {
  return nodes.flatMap((node) => isFolder(node) ? requestMap(node.children) : [node])
}

function findWorkspaceIds(): Array<{ id: string; name: string; cloudId: string | null; role: StoredWorkspace['role'] }> {
  const rows = database().prepare('SELECT data FROM workspaces ORDER BY rowid').all() as { data: string }[]
  return rows.map(({ data }) => {
    const workspace = JSON.parse(data) as StoredWorkspace
    return { id: workspace.id, name: workspace.name, cloudId: workspace.cloudId, role: workspace.role ?? null }
  })
}

function registerTools(server: McpServer): void {
  server.registerTool('list_workspaces', {
    title: 'List workspaces',
    description: 'List local workspaces available in the desktop app. Use the returned workspace id for other tools.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => jsonResult(findWorkspaceIds()))

  server.registerTool('get_collection_tree', {
    title: 'Read collection tree',
    description: 'Read folder hierarchy and request summaries for a workspace. Request names, methods, URLs, and deprecated status are included; credentials and environment values are not.',
    inputSchema: { workspaceId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ workspaceId }) => {
    const { workspace } = loadRawWorkspace(workspaceId)
    return jsonResult({ workspaceId, workspaceName: workspace.name, tree: safeTree(workspace.tree) })
  })

  server.registerTool('search_requests', {
    title: 'Search requests',
    description: 'Search request names, methods, and URLs in a workspace. Sensitive URL query values are masked.',
    inputSchema: { workspaceId: z.string().min(1), query: z.string().trim().min(1).max(200) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ workspaceId, query }) => {
    const { workspace } = loadRawWorkspace(workspaceId)
    const needle = query.toLocaleLowerCase()
    const matches = requestMap(workspace.tree).filter((request) => `${request.name}\n${request.method}\n${request.url}\n${request.documentation ?? ''}\n${(request.responses ?? []).map((response) => `${response.statusCode} ${response.description} ${response.content.map((content) => `${content.schema} ${content.example}`).join(' ')}`).join('\n')}`.toLocaleLowerCase().includes(needle))
    return jsonResult(matches.map((request) => safeRequest(request)))
  })

  server.registerTool('get_request', {
    title: 'Read request',
    description: 'Read one request definition. Auth credentials, secret-like header/parameter/body values, and local file paths are redacted.',
    inputSchema: { workspaceId: z.string().min(1), requestId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ workspaceId, requestId }) => {
    const { workspace } = loadRawWorkspace(workspaceId)
    const request = findNode(workspace.tree, requestId)
    if (!request || isFolder(request)) throw new Error(`Request "${requestId}" was not found.`)
    return jsonResult(safeRequest(request))
  })

  server.registerTool('preview_changes', {
    title: 'Preview collection changes',
    description: 'Validate a proposed batch and return sanitized before/after request data. The agent must render a readable diff in chat, including workspace and collection paths, changed request fields, and nested deletion impact, then wait for explicit user approval before apply_changes. Deletions also require confirmDelete=true when applying.',
    inputSchema: { workspaceId: z.string().min(1), operations: z.array(operationSchema).min(1).max(100) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ workspaceId, operations }) => {
    const { raw, workspace } = loadRawWorkspace(workspaceId)
    assertCanEdit(workspace)
    let tree = structuredClone(workspace.tree)
    const summary: PlannedChange['summary'] = []
    for (const operation of operations as ChangeOperation[]) {
      const result = collectSummary(tree, operation)
      tree = result.tree
      summary.push(result.summary)
    }
    const id = randomUUID()
    const plan: PlannedChange = {
      id,
      workspaceId,
      sourceHash: createHash('sha256').update(raw).digest('hex'),
      operations: operations as ChangeOperation[],
      nextTree: tree,
      summary,
      includesDelete: operations.some((operation) => operation.action === 'delete_node'),
      expiresAt: Date.now() + 10 * 60 * 1000
    }
    plans.set(id, plan)
    return jsonResult({ previewId: id, workspaceId, workspaceName: workspace.name, changes: summary, deletesItems: plan.includesDelete, expiresInSeconds: 600 })
  })

  server.registerTool('apply_changes', {
    title: 'Apply collection changes',
    description: 'Apply a previously previewed batch to the local workspace only after the user explicitly approved the readable preview shown in chat. Requires the workspace to be unchanged since preview. Set confirmDelete=true only when the user explicitly approved deleting the listed items.',
    inputSchema: { previewId: z.string().min(1), confirmDelete: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ previewId, confirmDelete }) => {
    const plan = plans.get(previewId)
    if (!plan || plan.expiresAt < Date.now()) {
      plans.delete(previewId)
      throw new Error('This preview expired or was not found. Run preview_changes again.')
    }
    if (plan.includesDelete && !confirmDelete) throw new Error('This batch includes deletion. Ask the user to confirm the listed deletions, then retry with confirmDelete=true.')

    const db = database()
    db.exec('BEGIN IMMEDIATE;')
    let updated: StoredWorkspace
    try {
      const { raw, workspace } = loadRawWorkspace(plan.workspaceId)
      assertCanEdit(workspace)
      const currentHash = createHash('sha256').update(raw).digest('hex')
      if (currentHash !== plan.sourceHash) throw new Error('The workspace changed after this preview. Run preview_changes again to avoid overwriting newer edits.')
      updated = { ...workspace, tree: structuredClone(plan.nextTree) }
      db.prepare('UPDATE workspaces SET data = ? WHERE id = ?').run(JSON.stringify(updated), plan.workspaceId)
      db.exec('COMMIT;')
    } catch (error) {
      db.exec('ROLLBACK;')
      throw error
    }
    plans.delete(previewId)
    process.stderr.write(`Applied MCP changes to workspace ${plan.workspaceId}.\n`)
    return jsonResult({ applied: true, workspaceId: plan.workspaceId, workspaceName: updated.name, changes: plan.summary })
  })
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'api-documentation-local', version: '1.0.0' }, {
    instructions: 'Use this server to maintain API endpoint documentation in local desktop workspaces. Search and read requests first. Record all known applicable route, params, headers, body, auth, response contracts, and documentation; do not invent missing details. Use {{baseUrl}} or other descriptive {{variableName}} references for reusable or environment-specific values, and {{accessToken}} for credentials; never write a real secret. Global variables are workspace-wide defaults, environment values can override them, and credentials should be marked Secret in the desktop Variables UI. This MCP can write request references but cannot read or manage variable definitions or values; tell the user when a referenced variable must be configured in the UI. Always call preview_changes, then render a readable diff directly in chat showing the workspace, full collection paths, each changed field before and after, response/body details, variable-definition gaps, and nested deletion impact. Redact secret values. Ask the user to approve that exact preview and stop; never call apply_changes in the same turn as the preview. Preserve existing auth and variable references unless asked to change them. Delete only when the user explicitly asks and confirms.'
  })
  registerTools(server)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
