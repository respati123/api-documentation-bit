import { useEffect, useState } from 'react'
import type { RequestNode } from '../types'

export function EndpointDocumentation({ request }: { request: RequestNode | null }) {
  const [activeSection, setActiveSection] = useState<'request' | 'responses'>('request')
  const [copied, setCopied] = useState(false)
  useEffect(() => { setActiveSection('request'); setCopied(false) }, [request?.id])
  if (!request) return <section className="endpoint-document empty-endpoint"><div><span className="empty-endpoint-mark" aria-hidden="true"><DocumentMark /></span><strong>Select an endpoint</strong><p>Choose a request from the collection to read its contract.</p></div></section>
  const requestUrl = request.url
  const auth = request.auth ?? { type: 'none' as const }
  const authLabel = auth.type === 'none' ? 'None' : auth.type === 'bearer' ? 'Bearer token' : auth.type === 'basic' ? 'Basic auth' : `API key · ${auth.location}`
  const bodyMode = request.bodyMode || (request.body.trim() ? 'json' : 'none')
  const pathParams = (request.pathParams ?? []).filter((row) => row.name.trim())
  const params = (request.params ?? []).filter((row) => row.enabled && row.name.trim())
  const headers = (request.headers ?? []).filter((row) => row.enabled && row.name.trim())
  const responses = request.responses ?? []
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(requestUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch { setCopied(false) }
  }
  return <article className="endpoint-document">
    <header className="endpoint-document-header">
      <p className="page-eyebrow">ENDPOINT REFERENCE</p>
      <div className="endpoint-name-line"><h2>{request.name}</h2>{request.deprecated && <span className="deprecated-label">Deprecated</span>}</div>
      <div className="endpoint-route"><span className={`method-label method-${request.method.toLowerCase()}`}>{request.method}</span><code>{requestUrl || 'No URL configured'}</code><button type="button" className="copy-route-button" onClick={copyUrl} aria-label="Copy endpoint URL">{copied ? 'Copied' : 'Copy URL'}</button></div>
      {request.deprecated && request.deprecationReason && <p className="deprecation-reason">{request.deprecationReason}</p>}
      {request.documentation?.trim() ? <p className="endpoint-description">{request.documentation}</p> : <p className="endpoint-description endpoint-description-empty">No endpoint description has been added.</p>}
      <dl className="endpoint-facts"><div><dt>Authentication</dt><dd>{authLabel}</dd></div><div><dt>Body</dt><dd>{bodyName(bodyMode)}</dd></div><div><dt>Responses</dt><dd>{responses.length} documented</dd></div></dl>
    </header>
    <div className="endpoint-sections" role="tablist" aria-label="Endpoint reference sections">
      <button type="button" role="tab" aria-selected={activeSection === 'request'} className={activeSection === 'request' ? 'endpoint-section-tab active' : 'endpoint-section-tab'} onClick={() => setActiveSection('request')}>Request</button>
      <button type="button" role="tab" aria-selected={activeSection === 'responses'} className={activeSection === 'responses' ? 'endpoint-section-tab active' : 'endpoint-section-tab'} onClick={() => setActiveSection('responses')}>Responses <span>{responses.length}</span></button>
    </div>
    {activeSection === 'request' ? <div className="endpoint-contract" role="tabpanel">
      <ContractTable title="Path parameters" rows={pathParams} />
      <ContractTable title="Query parameters" rows={params} />
      <ContractTable title="Headers" rows={headers} />
      <section className="contract-block"><div className="contract-heading"><h3>Authentication</h3><span>{authLabel}</span></div>{auth.type === 'none' ? <p className="contract-empty">No authentication is configured for this endpoint.</p> : <p className="auth-secret-note">Credential values are hidden in the browser reference.</p>}</section>
      <section className="contract-block"><div className="contract-heading"><h3>Request body</h3><span>{bodyName(bodyMode)}</span></div><BodyContent request={request} mode={bodyMode} /></section>
    </div> : <div className="endpoint-contract response-contract" role="tabpanel">
      {!responses.length ? <div className="contract-empty-panel"><strong>No response contract documented</strong><span>Add status codes, descriptions, schemas, and examples in the desktop app.</span></div> : responses.map((response) => <article className="response-contract-card" key={response.id}>
        <header><strong className={/^([45])/.test(response.statusCode) ? 'response-status response-status-error' : 'response-status'}>{response.statusCode || 'Status'}</strong><span>{response.description || 'Response'}</span></header>
        {!response.content.length && <p className="contract-empty">No response body documented.</p>}
        {response.content.map((content) => <div className="response-content-block" key={content.id}>
          <div className="response-content-heading"><strong>{content.mediaType || 'Response body'}</strong></div>
          {content.schema.trim() && <CodePanel label="Schema" value={content.schema} />}
          {content.example.trim() && <CodePanel label="Example" value={redactText(content.example)} />}
          {!content.schema.trim() && !content.example.trim() && <p className="contract-empty">No schema or example provided.</p>}
        </div>)}
      </article>)}
    </div>}
  </article>
}

function ContractTable({ title, rows }: { title: string; rows: Array<{ id: string; name: string; value: string; description?: string }> }) {
  return <section className="contract-block"><div className="contract-heading"><h3>{title}</h3><span>{rows.length}</span></div>{rows.length ? <div className="contract-table" role="table" aria-label={title}>
    <div className="contract-table-head" role="row"><span role="columnheader">Name</span><span role="columnheader">Example</span><span role="columnheader">Description</span></div>
    {rows.map((row) => <div className="contract-table-row" role="row" key={row.id}><code role="cell">{row.name}</code><span role="cell">{isSensitive(row.name) ? '••••••' : row.value || 'Not set'}</span><span role="cell">{row.description || 'No description'}</span></div>)}
  </div> : <p className="contract-empty">No {title.toLowerCase()} documented.</p>}</section>
}

function BodyContent({ request, mode }: { request: RequestNode; mode: string }) {
  if (mode === 'none') return <p className="contract-empty">This request has no body.</p>
  if (mode === 'form-data' || mode === 'urlencoded') {
    const fields = (request.bodyFields ?? []).filter((field) => field.enabled && field.name.trim())
    return fields.length ? <div className="body-field-list">{fields.map((field) => <div key={field.id}><code>{field.name}</code><span>{isSensitive(field.name) ? '••••••' : field.type === 'file' ? field.fileName || 'File' : field.value || 'Not set'}</span><small>{field.type}</small></div>)}</div> : <p className="contract-empty">No body fields documented.</p>
  }
  if (mode === 'file') return <p className="contract-empty">File upload · {request.bodyMimeType || 'application/octet-stream'}</p>
  if (mode === 'graphql') return <div className="body-code-stack"><CodePanel label="GraphQL query" value={redactText(request.body)} /><CodePanel label="Variables" value={redactText(request.bodyVariables || '{}')} /></div>
  return <CodePanel label={`${bodyName(mode)} example`} value={redactText(request.body)} />
}

function CodePanel({ label, value }: { label: string; value: string }) {
  return <div className="contract-code"><div>{label}</div><pre>{value || 'No example provided.'}</pre></div>
}

function bodyName(mode: string): string {
  const names: Record<string, string> = { 'form-data': 'Form data', urlencoded: 'Form URL encoded', graphql: 'GraphQL', json: 'JSON', xml: 'XML', yaml: 'YAML', edn: 'EDN', text: 'Plain text', other: 'Other', file: 'File', none: 'No body' }
  return names[mode] || mode
}

function isSensitive(value: string): boolean { return /authorization|cookie|token|secret|password|api[-_]?key/i.test(value) }
function redactText(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value)
    const redact = (entry: unknown): unknown => {
      if (Array.isArray(entry)) return entry.map(redact)
      if (!entry || typeof entry !== 'object') return entry
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, nested]) => [key, isSensitive(key) ? '••••••' : redact(nested)]))
    }
    return JSON.stringify(redact(parsed), null, 2)
  } catch {
    return value.replace(/((?:authorization|cookie|token|secret|password|api[-_]?key)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1••••••')
  }
}

function DocumentMark() { return <svg viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4.5h9l5 5v15H8v-20Z" /><path d="M17 4.8v5h5M11.5 14h7M11.5 18h7" /></svg> }
