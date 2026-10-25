import { FormEvent, ReactNode, CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall, checkApiHealth } from './api'
import { ActivityView } from './components/ActivityView'
import { AuthScreen } from './components/AuthScreen'
import { CloudShell } from './components/CloudShell'
import { DesktopLoginApprove } from './components/DesktopLoginApprove'
import { isDesktopLoopbackRedirect } from './desktop-redirect'
import { EndpointDocumentation } from './components/EndpointDocumentation'
import { TeamView } from './components/TeamView'
import { WorkspaceOverview } from './components/WorkspaceOverview'
import type { ApiNode, CloudCommit, CloudInvite, CloudMember, CloudUser, CloudWorkspaceRef, RequestNode, WorkspaceRole, WorkspaceSnapshot } from './types'

type WorkspaceTab = 'overview' | 'docs' | 'activity' | 'team'
type Route = { page: 'overview' | 'workspaces' | 'workspace'; workspaceId?: string; tab?: WorkspaceTab }
type Notice = { kind: 'success' | 'error' | 'info'; message: string }
type WorkspaceDetails = { snapshot: WorkspaceSnapshot; commits: CloudCommit[]; members: CloudMember[] }

const sessionKey = 'api-documentation-cloud-session'

function readRoute(): Route {
  const parts = window.location.pathname.split('/').filter(Boolean)
  if (parts[0] === 'workspaces') return { page: 'workspaces' }
  if (parts[0] === 'w' && parts[1]) {
    const tab = ['overview', 'docs', 'activity', 'team'].includes(parts[2] || '') ? parts[2] as WorkspaceTab : 'overview'
    return { page: 'workspace', workspaceId: parts[1], tab }
  }
  return { page: 'overview' }
}

function routeUrl(route: Route): string {
  if (route.page === 'workspaces') return '/workspaces'
  if (route.page === 'workspace' && route.workspaceId) return `/w/${encodeURIComponent(route.workspaceId)}/${route.tab || 'overview'}`
  return '/'
}

function isRequest(node: ApiNode): node is RequestNode { return node.kind === 'request' }

function collectCounts(nodes: ApiNode[]): { requests: number; folders: number } {
  return nodes.reduce((total, node) => {
    if (node.kind === 'request') total.requests += 1
    else {
      total.folders += 1
      const nested = collectCounts(node.children)
      total.requests += nested.requests
      total.folders += nested.folders
    }
    return total
  }, { requests: 0, folders: 0 })
}

function firstRequest(nodes: ApiNode[]): RequestNode | null {
  for (const node of nodes) {
    if (isRequest(node)) return node
    const nested = firstRequest(node.children)
    if (nested) return nested
  }
  return null
}

function findRequest(nodes: ApiNode[], id: string): RequestNode | null {
  for (const node of nodes) {
    if (node.kind === 'request' && node.id === id) return node
    if (node.kind === 'folder') {
      const nested = findRequest(node.children, id)
      if (nested) return nested
    }
  }
  return null
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(sessionKey) || '')
  const [user, setUser] = useState<CloudUser | null>(null)
  const [authChecking, setAuthChecking] = useState(() => Boolean(sessionStorage.getItem(sessionKey)))
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [workspaces, setWorkspaces] = useState<CloudWorkspaceRef[]>([])
  const [workspacesLoading, setWorkspacesLoading] = useState(false)
  const [workspacesError, setWorkspacesError] = useState('')
  const [route, setRoute] = useState<Route>(readRoute)
  const [details, setDetails] = useState<WorkspaceDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState('')
  const [invites, setInvites] = useState<CloudInvite[]>([])
  const [invitesLoading, setInvitesLoading] = useState(false)
  const [invitesError, setInvitesError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [docsSearch, setDocsSearch] = useState('')
  const [pendingInviteToken, setPendingInviteToken] = useState(() => new URLSearchParams(window.location.search).get('token') || '')
  const [desktopLoginState, setDesktopLoginState] = useState(() => new URLSearchParams(window.location.search).get('desktopLoginState') || '')
  const [desktopLoginRedirect] = useState(() => new URLSearchParams(window.location.search).get('redirect') || '')
  const [desktopLoginBusy, setDesktopLoginBusy] = useState(false)
  const [desktopLoginError, setDesktopLoginError] = useState('')
  const [desktopLoginDone, setDesktopLoginDone] = useState(false)
  const [inviteFeedback, setInviteFeedback] = useState('')
  const [lastInviteLink, setLastInviteLink] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [createError, setCreateError] = useState('')
  const [inviteError, setInviteError] = useState('')
  const [createName, setCreateName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor')
  const inviteAttempted = useRef(false)

  const navigate = useCallback((next: Route, replace = false) => {
    const url = routeUrl(next)
    if (replace) window.history.replaceState({}, '', url)
    else window.history.pushState({}, '', url)
    setRoute(next)
    setMobileNavOpen(false)
    setDocsSearch('')
  }, [])

  useEffect(() => {
    const onPopState = () => setRoute(readRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!token) {
      setAuthChecking(false)
      return
    }
    let active = true
    apiCall<{ user: CloudUser }>('/api/me', { token })
      .then(({ user: currentUser }) => { if (active) { setUser(currentUser); sessionStorage.setItem('api-documentation-cloud-user-id', currentUser.id) } })
      .catch(() => {
        if (!active) return
        sessionStorage.removeItem(sessionKey)
        setToken('')
        setUser(null)
        sessionStorage.removeItem('api-documentation-cloud-user-id')
        setAuthError('Your session expired. Sign in again to continue.')
      })
      .finally(() => { if (active) setAuthChecking(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!token || !user) return
    let active = true
    setWorkspacesLoading(true)
    setWorkspacesError('')
    Promise.all([
      apiCall<{ workspaces: CloudWorkspaceRef[] }>('/api/workspaces', { token }),
      checkApiHealth()
    ]).then(([result, healthy]) => {
      if (!active) return
      setWorkspaces(result.workspaces)
      setApiOnline(healthy)
    }).catch((error) => {
      if (active) setWorkspacesError(error instanceof Error ? error.message : 'Could not load workspaces.')
    }).finally(() => { if (active) setWorkspacesLoading(false) })
    return () => { active = false }
  }, [token, user])

  const requestedWorkspaceId = route.page === 'workspace' ? route.workspaceId : undefined
  useEffect(() => {
    if (!token || !requestedWorkspaceId) {
      setDetails(null)
      setDetailsError('')
      return
    }
    let active = true
    setDetailsLoading(true)
    setDetailsError('')
    Promise.all([
      apiCall<{ workspace: WorkspaceSnapshot | null }>(`/api/workspaces/${requestedWorkspaceId}/sync/pull`, { token }),
      apiCall<{ commits: CloudCommit[] }>(`/api/workspaces/${requestedWorkspaceId}/sync/history`, { token }),
      apiCall<{ members: CloudMember[] }>(`/api/workspaces/${requestedWorkspaceId}/members`, { token })
    ]).then(([pull, history, memberResult]) => {
      if (!active) return
      if (!pull.workspace) throw new Error('This workspace is no longer available to your account.')
      setDetails({ snapshot: pull.workspace, commits: history.commits, members: memberResult.members })
    }).catch((error) => {
      if (active) setDetailsError(error instanceof Error ? error.message : 'Could not load this workspace.')
    }).finally(() => { if (active) setDetailsLoading(false) })
    return () => { active = false }
  }, [token, requestedWorkspaceId])

  useEffect(() => {
    if (!token || !requestedWorkspaceId || route.tab !== 'team') {
      setInvites([])
      setInvitesError('')
      return
    }
    const workspace = workspaces.find((item) => item.id === requestedWorkspaceId)
    if (workspace?.role !== 'owner') {
      setInvites([])
      return
    }
    let active = true
    setInvitesLoading(true)
    apiCall<{ invites: CloudInvite[] }>(`/api/workspaces/${requestedWorkspaceId}/invites`, { token })
      .then(({ invites: pending }) => { if (active) setInvites(pending) })
      .catch((error) => { if (active) setInvitesError(error instanceof Error ? error.message : 'Could not load invitations.') })
      .finally(() => { if (active) setInvitesLoading(false) })
    return () => { active = false }
  }, [token, requestedWorkspaceId, route.tab, workspaces])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 5500)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!token || !user || !pendingInviteToken || inviteAttempted.current) return
    inviteAttempted.current = true
    setInviteFeedback('Accepting your workspace invitation…')
    apiCall<{ workspace: WorkspaceSnapshot }>('/api/invites/accept', { token, method: 'POST', body: { token: pendingInviteToken } })
      .then(({ workspace }) => {
        setInviteFeedback('')
        setPendingInviteToken('')
        setNotice({ kind: 'success', message: `You joined ${workspace.name}.` })
        navigate({ page: 'workspace', workspaceId: workspace.id, tab: 'overview' }, true)
        return apiCall<{ workspaces: CloudWorkspaceRef[] }>('/api/workspaces', { token })
      })
      .then((result) => { if (result) setWorkspaces(result.workspaces) })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Could not accept this invitation.'
        setInviteFeedback(message)
        setNotice({ kind: 'error', message })
      })
  }, [token, user, pendingInviteToken, navigate])

  const activeWorkspace = useMemo(() => workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ?? null, [workspaces, requestedWorkspaceId])
  const activeSnapshot = details?.snapshot
  const activeMembers = details?.members ?? []
  const activeCommits = details?.commits ?? []
  const activeTree = activeSnapshot?.tree ?? []
  const counts = useMemo(() => collectCounts(activeTree), [activeTree])
  const visibleEndpoints = useMemo(() => {
    const query = docsSearch.trim().toLowerCase()
    if (!query) return activeTree
    const filter = (nodes: ApiNode[]): ApiNode[] => {
      const result: ApiNode[] = []
      for (const node of nodes) {
        if (node.kind === 'request') {
          if (`${node.method} ${node.name} ${node.url}`.toLowerCase().includes(query)) result.push(node)
          continue
        }
        const children = filter(node.children)
        if (children.length) result.push({ ...node, children })
      }
      return result
    }
    return filter(activeTree)
  }, [activeTree, docsSearch])
  const firstVisibleRequest = useMemo(() => firstRequest(visibleEndpoints), [visibleEndpoints])
  const [selectedRequestId, setSelectedRequestId] = useState('')
  useEffect(() => {
    if (!findRequest(activeTree, selectedRequestId)) setSelectedRequestId(firstVisibleRequest?.id || '')
  }, [activeTree, firstVisibleRequest, selectedRequestId])
  const selectedRequest = useMemo(() => findRequest(visibleEndpoints, selectedRequestId) ?? firstVisibleRequest, [visibleEndpoints, selectedRequestId, firstVisibleRequest])

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>, email: string, password: string) {
    event.preventDefault()
    setAuthBusy(true)
    setAuthError('')
    try {
      const result = await apiCall<{ token: string; user: CloudUser }>(`/api/auth/${authMode}`, { method: 'POST', body: { email, password } })
      sessionStorage.setItem(sessionKey, result.token)
      setToken(result.token)
      setUser(result.user)
      sessionStorage.setItem('api-documentation-cloud-user-id', result.user.id)
      setAuthChecking(false)
      setApiOnline(await checkApiHealth())
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not sign in.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function approveDesktopLogin() {
    if (!token || !desktopLoginState) return
    if (!isDesktopLoopbackRedirect(desktopLoginRedirect)) {
      setDesktopLoginError('This sign-in link is not from the desktop app. Start sign-in again from the desktop app.')
      return
    }
    setDesktopLoginBusy(true)
    setDesktopLoginError('')
    try {
      const result = await apiCall<{ code: string }>('/api/desktop-login/approve', { token, method: 'POST' })
      const callback = new URL(desktopLoginRedirect)
      callback.searchParams.set('state', desktopLoginState)
      callback.searchParams.set('code', result.code)
      window.location.href = callback.toString()
      setDesktopLoginDone(true)
    } catch (error) {
      setDesktopLoginError(error instanceof Error ? error.message : 'Could not approve this sign-in.')
    } finally {
      setDesktopLoginBusy(false)
    }
  }

  function cancelDesktopLogin() {
    setDesktopLoginState('')
    navigate({ page: 'overview' }, true)
  }

  async function signOut() {
    if (token) await apiCall('/api/auth/logout', { token, method: 'POST' }).catch(() => undefined)
    sessionStorage.removeItem(sessionKey)
    setToken('')
    setUser(null)
    sessionStorage.removeItem('api-documentation-cloud-user-id')
    setWorkspaces([])
    setDetails(null)
    navigate({ page: 'overview' }, true)
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || !createName.trim()) return
    setCreateBusy(true)
    setCreateError('')
    try {
      const result = await apiCall<{ workspace: WorkspaceSnapshot }>('/api/workspaces', {
        token,
        method: 'POST',
        body: { name: createName.trim(), tree: [], variables: { globals: [], environments: [] } }
      })
      const listed = await apiCall<{ workspaces: CloudWorkspaceRef[] }>('/api/workspaces', { token })
      setWorkspaces(listed.workspaces)
      setCreateName('')
      setCreateOpen(false)
      navigate({ page: 'workspace', workspaceId: result.workspace.id, tab: 'overview' })
      setNotice({ kind: 'success', message: `${result.workspace.name} is ready in the cloud.` })
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create workspace.')
    } finally {
      setCreateBusy(false)
    }
  }

  async function sendInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || !requestedWorkspaceId || !inviteEmail.trim()) return
    setInviteBusy(true)
    setInviteError('')
    try {
      const result = await apiCall<{ token: string; email: string; emailSent: boolean }>(`/api/workspaces/${requestedWorkspaceId}/invites`, {
        token,
        method: 'POST',
        body: { email: inviteEmail.trim(), role: inviteRole }
      })
      const link = new URL(`/invite?token=${encodeURIComponent(result.token)}`, window.location.origin).toString()
      setLastInviteLink(link)
      const refreshed = await apiCall<{ invites: CloudInvite[] }>(`/api/workspaces/${requestedWorkspaceId}/invites`, { token })
      setInvites(refreshed.invites)
      setInviteEmail('')
      setInviteOpen(false)
      setNotice({ kind: result.emailSent ? 'success' : 'info', message: result.emailSent ? `Invitation sent to ${result.email}.` : `Invitation created for ${result.email}; email delivery is unavailable. Copy its link from Team.` })
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Could not send invitation.')
    } finally {
      setInviteBusy(false)
    }
  }

  async function cancelInvitation(inviteId: string) {
    if (!token || !requestedWorkspaceId) return
    try {
      await apiCall(`/api/workspaces/${requestedWorkspaceId}/invites/${inviteId}`, { token, method: 'DELETE' })
      setInvites((current) => current.filter((invite) => invite.id !== inviteId))
      setNotice({ kind: 'success', message: 'Invitation cancelled.' })
    } catch (error) {
      setInvitesError(error instanceof Error ? error.message : 'Could not cancel invitation.')
    }
  }

  async function copyInviteLink() {
    if (!lastInviteLink) return
    try {
      await navigator.clipboard.writeText(lastInviteLink)
      setNotice({ kind: 'success', message: 'Invitation link copied.' })
    } catch {
      setNotice({ kind: 'error', message: 'Clipboard access is unavailable in this browser.' })
    }
  }

  if (authChecking) return <div className="cloud-gate" role="status">Checking your session…</div>
  if (!token || !user) return <AuthScreen mode={authMode} setMode={setAuthMode} busy={authBusy} error={authError} inviteMessage={pendingInviteToken ? inviteFeedback || 'Sign in with the invited email address to join this workspace.' : desktopLoginState ? 'Sign in to approve the desktop app.' : ''} onSubmit={handleAuthSubmit} />
  if (desktopLoginState) return <DesktopLoginApprove email={user.email} busy={desktopLoginBusy} done={desktopLoginDone} error={desktopLoginError} onApprove={() => void approveDesktopLogin()} onCancel={cancelDesktopLogin} />

  const title = route.page === 'workspace' ? activeWorkspace?.name || activeSnapshot?.name || 'Workspace' : route.page === 'workspaces' ? 'Workspaces' : 'Overview'
  const routeForTab = (tab: WorkspaceTab): Route => ({ page: 'workspace', workspaceId: requestedWorkspaceId, tab })

  return <>
    <CloudShell
      route={route}
      title={title}
      user={user}
      workspaces={workspaces}
      apiOnline={apiOnline}
      mobileNavOpen={mobileNavOpen}
      docsSearch={docsSearch}
      showDocsSearch={route.page === 'workspace' && route.tab === 'docs'}
      onDocsSearch={setDocsSearch}
      onNavigate={navigate}
      onCreateWorkspace={() => { setCreateError(''); setCreateOpen(true) }}
      onSignOut={signOut}
      onMobileNavToggle={() => setMobileNavOpen((open) => !open)}
    >
      {notice && <div className={`cloud-notice cloud-notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}{lastInviteLink && route.tab === 'team' && <button type="button" onClick={copyInviteLink}>Copy invite link</button>}</div>}
      {route.page === 'overview' && <DashboardPage workspaces={workspaces} loading={workspacesLoading} error={workspacesError} onRetry={() => window.location.reload()} onOpen={((id) => navigate({ page: 'workspace', workspaceId: id, tab: 'overview' }))} onCreate={() => { setCreateError(''); setCreateOpen(true) }} />}
      {route.page === 'workspaces' && <WorkspacesPage workspaces={workspaces} loading={workspacesLoading} error={workspacesError} onOpen={(id) => navigate({ page: 'workspace', workspaceId: id, tab: 'overview' })} onCreate={() => { setCreateError(''); setCreateOpen(true) }} />}
      {route.page === 'workspace' && activeWorkspace && <WorkspacePage
        workspace={activeWorkspace}
        snapshot={activeSnapshot}
        commits={activeCommits}
        members={activeMembers}
        loading={detailsLoading}
        error={detailsError}
        tab={route.tab || 'overview'}
        tree={visibleEndpoints}
        counts={counts}
        selectedRequest={selectedRequest}
        selectedRequestId={selectedRequestId}
        invites={invites}
        invitesLoading={invitesLoading}
        invitesError={invitesError}
        lastInviteLink={lastInviteLink}
        onTab={(tab) => navigate(routeForTab(tab))}
        onRequestSelect={setSelectedRequestId}
        onInvite={() => { setInviteError(''); setInviteOpen(true) }}
        onCancelInvite={cancelInvitation}
        onCopyInvite={copyInviteLink}
        onRetry={() => setRoute({ ...route })}
      />}
      {route.page === 'workspace' && !activeWorkspace && !workspacesLoading && <section className="cloud-empty-page"><h1>Workspace unavailable</h1><p>This workspace may have been removed or your account no longer has access.</p><button type="button" className="cloud-button cloud-button-secondary" onClick={() => navigate({ page: 'workspaces' })}>Back to workspaces</button></section>}
    </CloudShell>

    {createOpen && <ModalDialog className="cloud-dialog" labelId="new-workspace-title" onClose={() => setCreateOpen(false)}>
      <form onSubmit={createWorkspace}>
        <div className="cloud-dialog-heading"><div><span className="cloud-dialog-kicker">CLOUD WORKSPACE</span><h2 id="new-workspace-title">Create workspace</h2><p>A shared space for collections, contracts, and team access.</p></div><button type="button" className="icon-button dialog-close" aria-label="Close dialog" onClick={() => setCreateOpen(false)}>×</button></div>
        <label className="cloud-field"><span>Workspace name</span><input autoFocus maxLength={100} required value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="e.g. Payments API" /></label>
        {createError && <p className="form-error" role="alert">{createError}</p>}
        <div className="cloud-dialog-actions"><button type="button" className="cloud-button cloud-button-secondary" onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" className="cloud-button cloud-button-primary" disabled={createBusy || !createName.trim()}>{createBusy ? 'Creating…' : 'Create workspace'}</button></div>
      </form>
    </ModalDialog>}

    {inviteOpen && requestedWorkspaceId && <ModalDialog className="cloud-dialog" labelId="invite-title" onClose={() => setInviteOpen(false)}>
      <form onSubmit={sendInvitation}>
        <div className="cloud-dialog-heading"><div><span className="cloud-dialog-kicker">{activeWorkspace?.name || 'WORKSPACE'}</span><h2 id="invite-title">Invite a teammate</h2><p>They must create or sign in with the invited email address.</p></div><button type="button" className="icon-button dialog-close" aria-label="Close dialog" onClick={() => setInviteOpen(false)}>×</button></div>
        <label className="cloud-field"><span>Email address</span><input type="email" autoFocus required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@company.com" /></label>
        <label className="cloud-field"><span>Workspace role</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'editor' | 'viewer')}><option value="editor">Editor · can edit and push</option><option value="viewer">Viewer · can read and pull</option></select></label>
        {inviteError && <p className="form-error" role="alert">{inviteError}</p>}
        <div className="cloud-dialog-actions"><button type="button" className="cloud-button cloud-button-secondary" onClick={() => setInviteOpen(false)}>Cancel</button><button type="submit" className="cloud-button cloud-button-primary" disabled={inviteBusy || !inviteEmail.trim()}>{inviteBusy ? 'Sending…' : 'Send invitation'}</button></div>
      </form>
    </ModalDialog>}
  </>
}

function DashboardPage({ workspaces, loading, error, onRetry, onOpen, onCreate }: { workspaces: CloudWorkspaceRef[]; loading: boolean; error: string; onRetry: () => void; onOpen: (id: string) => void; onCreate: () => void }) {
  const owned = workspaces.filter((workspace) => workspace.role === 'owner').length
  return <div className="cloud-page">
    <div className="page-heading"><div><p className="page-eyebrow">TEAM CLOUD</p><h1>Overview</h1><p>Shared API workspaces, endpoint contracts, and team access.</p></div><button type="button" className="cloud-button cloud-button-primary" onClick={onCreate}><span className="button-plus">+</span>New workspace</button></div>
    <section className="cloud-surface workspace-list-surface"><div className="surface-heading"><div><h2>Your workspaces</h2><p>Open a workspace to browse its API documentation and team history.</p></div><button type="button" className="text-action" onClick={onCreate}>Create workspace</button></div>
      {loading ? <LoadingState label="Loading workspaces…" /> : error ? <ErrorState message={error} onRetry={onRetry} /> : !workspaces.length ? <EmptyState title="No cloud workspaces yet" detail="Create one here, or publish a local workspace from the desktop app." action={<button type="button" className="cloud-button cloud-button-primary" onClick={onCreate}>Create workspace</button>} /> : <div className="workspace-list">{workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} onOpen={() => onOpen(workspace.id)} />)}</div>}
    </section>
    <div className="summary-strip" aria-label="Workspace summary"><div><strong>{loading ? '…' : workspaces.length}</strong><span>Workspaces</span></div><div><strong>{loading ? '…' : owned}</strong><span>Owned by you</span></div><div><strong>{loading ? '…' : workspaces.length - owned}</strong><span>Shared with you</span></div></div>
  </div>
}

function WorkspacesPage({ workspaces, loading, error, onOpen, onCreate }: { workspaces: CloudWorkspaceRef[]; loading: boolean; error: string; onOpen: (id: string) => void; onCreate: () => void }) {
  return <div className="cloud-page">
    <div className="page-heading"><div><p className="page-eyebrow">TEAM CLOUD</p><h1>Workspaces</h1><p>Collections shared with your account.</p></div><button type="button" className="cloud-button cloud-button-primary" onClick={onCreate}><span className="button-plus">+</span>New workspace</button></div>
    <section className="cloud-surface workspace-list-surface"><div className="surface-heading"><div><h2>All workspaces</h2><p>{workspaces.length} available to your account</p></div></div>
      {loading ? <LoadingState label="Loading workspaces…" /> : error ? <ErrorState message={error} onRetry={() => window.location.reload()} /> : !workspaces.length ? <EmptyState title="No workspaces to show" detail="Create a workspace or ask a teammate to invite you." action={<button type="button" className="cloud-button cloud-button-primary" onClick={onCreate}>Create workspace</button>} /> : <div className="workspace-list">{workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} onOpen={() => onOpen(workspace.id)} />)}</div>}
    </section>
  </div>
}

function WorkspaceRow({ workspace, onOpen }: { workspace: CloudWorkspaceRef; onOpen: () => void }) {
  return <button type="button" className="workspace-row" onClick={onOpen}>
    <span className="workspace-row-mark" aria-hidden="true"><Icon name="layers" /></span>
    <span className="workspace-row-name"><strong>{workspace.name}</strong><small>Updated {formatDate(workspace.updatedAt || workspace.createdAt)}</small></span>
    <span className={`role-label role-${workspace.role}`}>{roleLabel(workspace.role)}</span>
    <span className="workspace-row-open">Open <Icon name="chevron-right" /></span>
  </button>
}

function WorkspacePage(props: {
  workspace: CloudWorkspaceRef
  snapshot?: WorkspaceSnapshot
  commits: CloudCommit[]
  members: CloudMember[]
  loading: boolean
  error: string
  tab: WorkspaceTab
  tree: ApiNode[]
  counts: { requests: number; folders: number }
  selectedRequest: RequestNode | null
  selectedRequestId: string
  invites: CloudInvite[]
  invitesLoading: boolean
  invitesError: string
  lastInviteLink: string
  onTab: (tab: WorkspaceTab) => void
  onRequestSelect: (id: string) => void
  onInvite: () => void
  onCancelInvite: (id: string) => void
  onCopyInvite: () => void
  onRetry: () => void
}) {
  const { workspace, snapshot, commits, members, loading, error, tab, counts } = props
  return <div className="cloud-page workspace-page">
    <div className="workspace-heading"><div className="workspace-heading-title"><p className="page-eyebrow">CLOUD WORKSPACE</p><div className="workspace-title-line"><h1>{workspace.name}</h1><span className={`role-label role-${workspace.role}`}>{roleLabel(workspace.role)}</span></div><p>Shared collection, API reference, and change history.</p></div>{tab === 'team' && workspace.role === 'owner' && <button type="button" className="cloud-button cloud-button-primary" onClick={props.onInvite}><span className="button-plus">+</span>Invite teammate</button>}</div>
    <nav className="workspace-tabs" aria-label="Workspace sections">{(['overview', 'docs', 'activity', 'team'] as WorkspaceTab[]).map((item) => <button key={item} type="button" className={tab === item ? 'workspace-tab active' : 'workspace-tab'} aria-current={tab === item ? 'page' : undefined} onClick={() => props.onTab(item)}>{tabName(item)}{item === 'team' && <span className="tab-count">{members.length}</span>}</button>)}</nav>
    {loading && !snapshot ? <LoadingState label="Loading workspace…" /> : error ? <ErrorState message={error} onRetry={props.onRetry} /> : !snapshot ? <EmptyState title="Workspace data is unavailable" detail="Refresh this view or check your access." /> : <>
      {tab === 'overview' && <WorkspaceOverview workspace={workspace} snapshot={snapshot} counts={counts} members={members} commits={commits} onTab={props.onTab} />}
      {tab === 'docs' && <div className="docs-browser">
        <CollectionTree nodes={props.tree} selectedId={props.selectedRequestId} onSelect={props.onRequestSelect} />
        <EndpointDocumentation request={props.selectedRequest} />
      </div>}
      {tab === 'activity' && <ActivityView workspaceId={workspace.id} token={getSessionToken()} commits={commits} />}
      {tab === 'team' && <TeamView workspace={workspace} currentUserId={userId()} members={members} invites={props.invites} loading={props.invitesLoading} error={props.invitesError} onInvite={props.onInvite} onCancelInvite={props.onCancelInvite} lastInviteLink={props.lastInviteLink} onCopyInvite={props.onCopyInvite} />}
    </>}
  </div>
}

function CollectionTree({ nodes, selectedId, onSelect }: { nodes: ApiNode[]; selectedId: string; onSelect: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(nodes.filter((node) => node.kind === 'folder').map((node) => node.id)))
  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current)
      const openAncestors = (items: ApiNode[]): boolean => {
        for (const item of items) {
          if (item.kind === 'request' && item.id === selectedId) return true
          if (item.kind === 'folder' && openAncestors(item.children)) {
            next.add(item.id)
            return true
          }
        }
        return false
      }
      openAncestors(nodes)
      return next
    })
  }, [nodes, selectedId])
  const render = (items: ApiNode[], depth = 0) => items.map((item) => item.kind === 'folder'
    ? <div className="tree-branch" key={item.id}>
      <button type="button" className="collection-tree-folder" style={{ '--tree-depth': depth } as CSSProperties} aria-expanded={expanded.has(item.id)} onClick={() => setExpanded((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next })}>
        <Icon name={expanded.has(item.id) ? 'chevron-down' : 'chevron-right'} /><Icon name="folder" /><span>{item.name}</span><small>{collectCounts(item.children).requests}</small>
      </button>
      {expanded.has(item.id) && <div>{render(item.children, depth + 1)}</div>}
    </div>
    : <button type="button" key={item.id} className={`collection-tree-request ${selectedId === item.id ? 'selected' : ''}`} style={{ '--tree-depth': depth } as CSSProperties} onClick={() => onSelect(item.id)}>
      <span className={`method-label method-${item.method.toLowerCase()}`}>{item.method}</span><span>{item.name}</span>
    </button>)
  return <aside className="collection-tree"><div className="collection-tree-heading"><div><span className="section-label">COLLECTION</span><strong>API endpoints</strong></div><span className="tree-total">{collectCounts(nodes).requests}</span></div>{nodes.length ? <div className="collection-tree-content">{render(nodes)}</div> : <p className="tree-empty">No collections in this workspace yet.</p>}</aside>
}

function LoadingState({ label }: { label: string }) { return <div className="view-state" role="status"><span className="loading-mark" aria-hidden="true" /><strong>{label}</strong></div> }
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="view-state error-state" role="alert"><strong>Could not load this view</strong><span>{message}</span><button type="button" className="cloud-button cloud-button-secondary" onClick={onRetry}>Try again</button></div> }
function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) { return <div className="view-state empty-state"><strong>{title}</strong><span>{detail}</span>{action}</div> }

function roleLabel(role: WorkspaceRole): string { return role[0].toUpperCase() + role.slice(1) }
function tabName(tab: WorkspaceTab): string { return tab === 'docs' ? 'API docs' : tab[0].toUpperCase() + tab.slice(1) }
function formatDate(value: string | null | undefined): string {
  if (!value) return 'not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'not available'
  const delta = Date.now() - date.getTime()
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} days ago`
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function getSessionToken(): string { return sessionStorage.getItem(sessionKey) || '' }
function userId(): string { return sessionStorage.getItem('api-documentation-cloud-user-id') || '' }

function ModalDialog({ className, labelId, onClose, children }: { className: string; labelId: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  return <dialog ref={dialog} className={className} aria-modal="true" aria-labelledby={labelId} onCancel={(event) => { event.preventDefault(); onClose() }} onClose={onClose}>{children}</dialog>
}

function Icon({ name }: { name: 'layers' | 'chevron-right' | 'chevron-down' | 'folder' }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" className="cloud-icon">
    {name === 'layers' && <><path d="m10 2.8 7 3.8-7 3.8-7-3.8 7-3.8Z" /><path d="m3 10 7 3.8 7-3.8M3 13.2l7 3.8 7-3.8" /></>}
    {name === 'chevron-right' && <path d="m7.5 4.5 5 5.5-5 5.5" />}
    {name === 'chevron-down' && <path d="m4.5 7.5 5.5 5 5.5-5" />}
    {name === 'folder' && <path d="M2.8 5.7c0-.7.5-1.2 1.2-1.2h4l1.5 1.6h6.5c.7 0 1.2.5 1.2 1.2v6.8c0 .7-.5 1.2-1.2 1.2H4c-.7 0-1.2-.5-1.2-1.2V5.7Z" />}
  </svg>
}
