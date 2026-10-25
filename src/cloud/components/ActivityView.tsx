import { useEffect, useMemo, useState } from 'react'
import { apiCall } from '../api'
import type { ApiNode, CloudCommit, RequestNode } from '../types'

type SnapshotCommit = { id: string; parentIds: string[]; message: string; tree: ApiNode[]; createdAt: string }
type Change = { id: string; label: string; kind: 'added' | 'modified' | 'deleted'; before: string; after: string }

export function ActivityView({ workspaceId, token, commits }: { workspaceId: string; token: string; commits: CloudCommit[] }) {
  const [selectedId, setSelectedId] = useState('')
  const [before, setBefore] = useState<ApiNode[]>([])
  const [after, setAfter] = useState<ApiNode[]>([])
  const [selectedChange, setSelectedChange] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadedCommit, setLoadedCommit] = useState('')
  const selectedCommit = commits.find((commit) => commit.id === selectedId) ?? commits[0]

  useEffect(() => {
    if (!commits.length) { setSelectedId(''); return }
    if (!commits.some((commit) => commit.id === selectedId)) setSelectedId(commits[0].id)
  }, [commits, selectedId])

  useEffect(() => {
    if (!selectedCommit || !token) return
    let active = true
    setLoading(true)
    setError('')
    setLoadedCommit('')
    const load = async () => {
      const currentResult = await apiCall<{ commit: SnapshotCommit }>(`/api/workspaces/${workspaceId}/sync/history/${selectedCommit.id}`, { token })
      let parentTree: ApiNode[] = []
      const parentId = selectedCommit.parentIds[0]
      if (parentId) {
        const parentResult = await apiCall<{ commit: SnapshotCommit }>(`/api/workspaces/${workspaceId}/sync/history/${parentId}`, { token })
        parentTree = parentResult.commit.tree
      }
      return { currentTree: currentResult.commit.tree, parentTree }
    }
    load().then(({ currentTree, parentTree }) => {
      if (!active) return
      setAfter(currentTree)
      setBefore(parentTree)
      setLoadedCommit(selectedCommit.id)
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load this commit.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token, workspaceId, selectedCommit])

  const changes = useMemo(() => loadedCommit === selectedCommit?.id ? compareSnapshots(before, after) : [], [before, after, loadedCommit, selectedCommit?.id])
  useEffect(() => {
    if (!changes.some((change) => change.id === selectedChange)) setSelectedChange(changes[0]?.id || '')
  }, [changes, selectedChange])
  const activeChange = changes.find((change) => change.id === selectedChange) ?? changes[0]

  if (!commits.length) return <section className="cloud-surface activity-empty"><h2>No cloud commits yet</h2><p>Push a commit from the desktop app to start a shared workspace history.</p></section>
  return <div className="activity-view">
    <section className="cloud-surface history-list-panel">
      <div className="surface-heading"><div><h2>Commit history</h2><p>{commits.length} {commits.length === 1 ? 'commit' : 'commits'} in this workspace</p></div></div>
      <ol className="history-commit-list">{commits.map((commit) => <li key={commit.id}>
        <button type="button" className={`history-commit ${selectedCommit?.id === commit.id ? 'selected' : ''}`} aria-current={selectedCommit?.id === commit.id ? 'true' : undefined} onClick={() => setSelectedId(commit.id)}>
          <span className="history-commit-marker" aria-hidden="true" />
          <span className="history-commit-copy"><strong>{commit.message}</strong><small>{commit.authorEmail}</small><time dateTime={commit.createdAt}>{formatDate(commit.createdAt)}</time></span>
          <code>{commit.id.slice(0, 7)}</code>
        </button>
      </li>)}</ol>
    </section>
    <section className="cloud-surface history-detail-panel" aria-live="polite">
      {selectedCommit && <div className="history-detail-heading"><div><span className="page-eyebrow">COMMIT</span><h2>{selectedCommit.message}</h2><p>{selectedCommit.authorEmail} · {formatDate(selectedCommit.createdAt)}</p></div><code>{selectedCommit.id.slice(0, 10)}</code></div>}
      {loading ? <div className="view-state"><span className="loading-mark" aria-hidden="true" /><strong>Loading commit diff…</strong></div> : error ? <div className="history-error" role="alert"><strong>Commit details could not be loaded</strong><span>{error}</span></div> : !changes.length ? <div className="view-state"><strong>No item changes</strong><span>This commit contains no collection changes.</span></div> : <div className="commit-diff">
        <div className="commit-change-list" aria-label="Changed items">{changes.map((change) => <button type="button" key={change.id} className={`commit-change-row ${selectedChange === change.id ? 'selected' : ''}`} onClick={() => setSelectedChange(change.id)}><span className={`change-kind change-${change.kind}`}>{change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M'}</span><span>{change.label}</span></button>)}</div>
        {activeChange && <div className="commit-change-diff"><div className="diff-pane"><div><span>Previous</span><span>{activeChange.kind === 'added' ? 'No earlier version' : 'Before commit'}</span></div><pre>{activeChange.before || '(empty)'}</pre></div><div className="diff-pane"><div><span>Committed</span><span>{activeChange.kind === 'deleted' ? 'Removed' : 'After commit'}</span></div><pre>{activeChange.after || '(empty)'}</pre></div></div>}
      </div>}
    </section>
  </div>
}

function compareSnapshots(before: ApiNode[], after: ApiNode[]): Change[] {
  const previous = flatten(before)
  const current = flatten(after)
  const ids = new Set([...previous.keys(), ...current.keys()])
  const changes: Change[] = []
  for (const id of ids) {
    const oldNode = previous.get(id)
    const newNode = current.get(id)
    const oldText = oldNode ? JSON.stringify(publicNode(oldNode), null, 2) : ''
    const newText = newNode ? JSON.stringify(publicNode(newNode), null, 2) : ''
    if (oldText === newText) continue
    const node = newNode ?? oldNode!
    changes.push({
      id,
      label: node.kind === 'request' ? `${node.method} ${node.name}` : node.name,
      kind: !oldNode ? 'added' : !newNode ? 'deleted' : 'modified',
      before: oldText,
      after: newText
    })
  }
  return changes
}

function flatten(nodes: ApiNode[]): Map<string, ApiNode> {
  const result = new Map<string, ApiNode>()
  const visit = (items: ApiNode[]) => items.forEach((node) => {
    result.set(node.id, node.kind === 'folder' ? { id: node.id, kind: 'folder', name: node.name, children: [] } : node)
    if (node.kind === 'folder') visit(node.children)
  })
  visit(nodes)
  return result
}

function publicNode(node: ApiNode): Record<string, unknown> {
  if (node.kind === 'folder') return { kind: node.kind, name: node.name }
  return {
    kind: node.kind,
    name: node.name,
    method: node.method,
    url: node.url,
    documentation: node.documentation || '',
    params: node.params?.map((param) => ({ ...param, value: isSensitive(param.name) ? '••••••' : param.value })) || [],
    headers: node.headers?.map((header) => ({ ...header, value: isSensitive(header.name) ? '••••••' : header.value })) || [],
    auth: node.auth?.type === 'none' || !node.auth ? { type: 'none' } : { type: node.auth.type },
    bodyMode: node.bodyMode || (node.body.trim() ? 'json' : 'none'),
    body: redactText(node.body),
    responses: node.responses?.map((response) => ({ ...response, content: response.content.map((content) => ({ ...content, example: redactText(content.example) })) })) || [],
    deprecated: Boolean(node.deprecated),
    deprecationReason: node.deprecationReason || ''
  }
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
  } catch { return value.replace(/((?:authorization|cookie|token|secret|password|api[-_]?key)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1••••••') }
}
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
