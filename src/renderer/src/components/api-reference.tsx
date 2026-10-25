import { Button } from '@/components/ui/button'
import type { BodyMode, SyncRequest } from '@/lib/merge'

const bodyModeNames: Record<BodyMode, string> = {
  'form-data': 'Form Data', urlencoded: 'Form URL Encoded', graphql: 'GraphQL', json: 'JSON', xml: 'XML', yaml: 'YAML', edn: 'EDN', text: 'Plain Text', other: 'Other', file: 'File', none: 'No Body'
}

function sensitiveName(value: string): boolean {
  return /authorization|cookie|token|secret|password|api[-_]?key/i.test(value)
}

function bodyMode(request: SyncRequest): BodyMode {
  return request.bodyMode ?? (request.body.trim() ? 'json' : 'none')
}

function schemaForDisplay(source: string, components: Record<string, unknown> | undefined): string {
  if (!source.trim()) return source
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return source }
  const expand = (value: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => expand(item, seen))
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    const reference = typeof object.$ref === 'string' ? object.$ref : ''
    if (!reference.startsWith('#/components/schemas/')) return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, expand(item, seen)]))
    if (seen.has(reference)) return object
    const [component = '', ...path] = reference.slice('#/components/schemas/'.length).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    let target: unknown = components?.[component]
    for (const segment of path) target = target && typeof target === 'object' ? (target as Record<string, unknown>)[segment] : undefined
    if (target === undefined) return object
    const expanded = expand(target, new Set(seen).add(reference))
    const siblings = Object.fromEntries(Object.entries(object).filter(([key]) => key !== '$ref').map(([key, item]) => [key, expand(item, seen)]))
    return expanded && typeof expanded === 'object' && !Array.isArray(expanded) ? { ...expanded, ...siblings } : expanded
  }
  return JSON.stringify(expand(parsed, new Set()), null, 2) ?? source
}

function RequestPayload({ request }: { request: SyncRequest }) {
  const mode = bodyMode(request)
  const fields = (request.bodyFields ?? []).filter((field) => field.enabled && field.name.trim())
  if (mode === 'none') return <p className="docs-muted">This request has no body.</p>
  if (mode === 'form-data' || mode === 'urlencoded') return fields.length
    ? <div className="docs-key-values">{fields.map((field) => <div className="docs-key-value" key={field.id}><strong>{field.name}</strong><code>{sensitiveName(field.name) ? '••••••' : field.type === 'file' ? field.fileName || 'File' : field.value || 'No example'}</code></div>)}</div>
    : <p className="docs-muted">No enabled body fields.</p>
  if (mode === 'file') return <p className="docs-muted">Raw file body · {request.bodyMimeType || 'application/octet-stream'}</p>
  if (mode === 'graphql') return <div className="docs-code-stack"><CodeBlock label="GraphQL query" value={request.body} /><CodeBlock label="Variables" value={request.bodyVariables || '{}'} /></div>
  return <CodeBlock label={`${bodyModeNames[mode]} payload`} value={request.body} />
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return <div className="docs-code-block"><div>{label}</div><pre>{value || 'No example provided.'}</pre></div>
}

export function ApiReferencePage({ request, folderName, onOpenRequest, onOpenOpenApi }: { request: SyncRequest; folderName: string; onOpenRequest: () => void; onOpenOpenApi: () => void }) {
  const pathParams = (request.pathParams ?? []).filter((item) => item.name.trim())
  const params = (request.params ?? []).filter((item) => item.enabled && item.name.trim())
  const headers = (request.headers ?? []).filter((item) => item.enabled && item.name.trim())
  const auth = request.auth ?? { type: 'none' as const }
  const authDescription = auth.type === 'none' ? 'None'
    : auth.type === 'api-key' ? `API Key · ${auth.location === 'header' ? 'header' : 'query'}${auth.name ? ` · ${auth.name}` : ''}`
      : auth.type === 'basic' ? 'Basic Auth'
        : 'Bearer Token'
  const responses = request.responses ?? []

  return <section className="request-card docs-page" aria-label={`API documentation for ${request.name}`}>
    <header className="docs-page-heading">
      <div><p className="section-kicker">{folderName} / API reference</p><h2>{request.name}</h2></div>
      <div className="docs-page-actions"><Button type="button" variant="outline" size="sm" onClick={onOpenOpenApi}>OpenAPI</Button><Button type="button" size="sm" onClick={onOpenRequest}>Open request</Button></div>
    </header>
    <div className="docs-page-content">
      <div className="docs-route-line">
        <span className={`docs-method method-${request.method.toLowerCase()}`}>{request.method}</span>
        <code>{request.url || 'No URL configured'}</code>
        {request.deprecated && <span className="docs-deprecated">Deprecated</span>}
      </div>
      {request.deprecated && request.deprecationReason && <p className="docs-deprecation-reason">{request.deprecationReason}</p>}
      {request.documentation?.trim() && <section className="docs-section"><h2>Overview</h2><p className="docs-description">{request.documentation}</p></section>}
      <section className="docs-section">
        <h2>Request</h2>
        <div className="docs-request-facts">
          <div><span>Authentication</span><strong>{authDescription}</strong></div>
          <div><span>Body type</span><strong>{bodyModeNames[bodyMode(request)]}</strong></div>
        </div>
        {pathParams.length > 0 && <div className="docs-subsection"><h3>Path parameters</h3><div className="docs-table"><div className="docs-table-heading"><span>Name</span><span>Example</span><span>Description</span></div>{pathParams.map((param) => <div className="docs-table-row" key={param.id}><code>{param.name}</code><span>{sensitiveName(param.name) ? '••••••' : param.value || 'Required'}</span><span>{param.description || 'No description'}</span></div>)}</div></div>}
        {params.length > 0 && <div className="docs-subsection"><h3>Query parameters</h3><div className="docs-table"><div className="docs-table-heading"><span>Name</span><span>Example</span><span>Description</span></div>{params.map((param) => <div className="docs-table-row" key={param.id}><code>{param.name}</code><span>{sensitiveName(param.name) ? '••••••' : param.value || 'No example'}</span><span>{param.description || 'No description'}</span></div>)}</div></div>}
        {headers.length > 0 && <div className="docs-subsection"><h3>Headers</h3><div className="docs-table"><div className="docs-table-heading"><span>Name</span><span>Example</span><span>Description</span></div>{headers.map((header) => <div className="docs-table-row" key={header.id}><code>{header.name}</code><span>{sensitiveName(header.name) ? '••••••' : header.value || 'No example'}</span><span>{header.description || 'No description'}</span></div>)}</div></div>}
        <div className="docs-subsection"><h3>Body</h3><RequestPayload request={request} /></div>
      </section>
      <section className="docs-section">
        <div className="docs-section-heading"><h2>Responses</h2><span>{responses.length} documented</span></div>
        {!responses.length && <div className="docs-empty"><strong>No response contract yet</strong><span>Open the request builder to add status codes, schemas, and example payloads.</span></div>}
        {responses.map((response) => <article className="docs-response" key={response.id}>
          <header><strong className={/^([45])/.test(response.statusCode) ? 'docs-status-error' : 'docs-status-success'}>{response.statusCode || 'Status'}</strong><span>{response.description || 'Response'}</span></header>
          {response.content.map((content) => <div className="docs-response-content" key={content.id}>
            <p className="docs-content-type">{content.mediaType || 'Content'}</p>
            {content.schema.trim() && <CodeBlock label="Schema" value={schemaForDisplay(content.schema, request.openApiSchemas)} />}
            {content.example.trim() && <CodeBlock label="Example payload" value={content.example} />}
            {!content.schema.trim() && !content.example.trim() && <p className="docs-muted">No schema or example provided.</p>}
          </div>)}
          {!response.content.length && <p className="docs-muted docs-response-empty">No response body.</p>}
        </article>)}
      </section>
    </div>
  </section>
}
