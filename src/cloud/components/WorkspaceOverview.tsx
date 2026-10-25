import type { CloudCommit, CloudMember, CloudWorkspaceRef, ApiNode, WorkspaceSnapshot } from '../types'

type Props = { workspace: CloudWorkspaceRef; snapshot: WorkspaceSnapshot; counts: { requests: number; folders: number }; members: CloudMember[]; commits: CloudCommit[]; onTab: (tab: 'overview' | 'docs' | 'activity' | 'team') => void }

export function WorkspaceOverview({ workspace, snapshot, counts, members, commits, onTab }: Props) {
  const recent = commits.slice(0, 5)
  return <div className="workspace-overview">
    <dl className="workspace-facts">
      <div><dt>Endpoints</dt><dd>{counts.requests}</dd></div>
      <div><dt>Collections</dt><dd>{counts.folders}</dd></div>
      <div><dt>Team members</dt><dd>{members.length}</dd></div>
      <div><dt>Latest change</dt><dd>{snapshot.createdAt ? relativeDate(snapshot.createdAt) : 'Not available'}</dd></div>
    </dl>
    <div className="overview-columns">
      <section className="cloud-surface collection-summary">
        <div className="surface-heading"><div><h2>Collections</h2><p>Folders and requests in this workspace.</p></div><button type="button" className="text-action" onClick={() => onTab('docs')}>Browse API docs</button></div>
        {snapshot.tree.length ? <div className="collection-summary-list">{snapshot.tree.slice(0, 8).map((node) => <button type="button" className="collection-summary-row" key={node.id} onClick={() => onTab('docs')}>
          <span className="summary-folder-mark" aria-hidden="true">{node.kind === 'folder' ? <FolderMark /> : <RequestMark />}</span>
          <span className="collection-summary-name"><strong>{node.name}</strong><small>{node.kind === 'folder' ? `${countRequests(node.children)} ${plural(countRequests(node.children), 'endpoint')}` : `${node.method} · ${node.url || 'No URL'}`}</small></span>
          <span className="summary-chevron" aria-hidden="true">›</span>
        </button>)}</div> : <div className="embedded-empty"><strong>No API collections yet</strong><span>Publish a collection from the desktop app to make its documentation available here.</span></div>}
      </section>
      <section className="cloud-surface activity-summary">
        <div className="surface-heading"><div><h2>Recent changes</h2><p>Commits pushed to the cloud workspace.</p></div><button type="button" className="text-action" onClick={() => onTab('activity')}>View history</button></div>
        {recent.length ? <ol className="recent-commit-list">{recent.map((commit) => <li key={commit.id}>
          <span className="commit-line-mark" aria-hidden="true" />
          <div><strong>{commit.message}</strong><span>{commit.authorEmail} · {relativeDate(commit.createdAt)}</span></div>
        </li>)}</ol> : <div className="embedded-empty"><strong>No commits yet</strong><span>Changes pushed from the desktop app will appear here.</span></div>}
      </section>
    </div>
    <p className="workspace-sync-note"><span className="sync-mark" aria-hidden="true" />This browser view reflects the latest version pushed to the cloud. Edit and sync local drafts from the desktop app.</p>
    <div className="workspace-access-line"><span>Created {formatDate(workspace.createdAt)}</span><span>Workspace ID <code>{workspace.id.slice(0, 8)}</code></span><button type="button" className="inline-action" onClick={() => onTab('team')}>Manage team</button></div>
  </div>
}

function countRequests(nodes: ApiNode[]): number { return nodes.reduce((count, node) => count + (node.kind === 'request' ? 1 : countRequests(node.children)), 0) }
function plural(value: number, singular: string): string { return value === 1 ? singular : `${singular}s` }
function relativeDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'date unavailable'
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60_000) return 'just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} days ago`
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}
function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}
function FolderMark() { return <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2.5 5.4c0-.6.4-1 1-1h3.8l1.3 1.4h5.9c.6 0 1 .4 1 1v5.8c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1V5.4Z" /></svg> }
function RequestMark() { return <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 2.5h6.7l3.3 3.3v9.7H4V2.5Z" /><path d="M10.5 2.8v3.5H14M6.5 9h5M6.5 11.8h5" /></svg> }
