import type { ReactNode } from 'react'
import type { CloudUser, CloudWorkspaceRef } from '../types'

type Route = { page: 'overview' | 'workspaces' | 'workspace'; workspaceId?: string; tab?: 'overview' | 'docs' | 'activity' | 'team' }
type Props = {
  route: Route
  title: string
  user: CloudUser
  workspaces: CloudWorkspaceRef[]
  apiOnline: boolean | null
  mobileNavOpen: boolean
  docsSearch: string
  showDocsSearch: boolean
  onDocsSearch: (value: string) => void
  onNavigate: (route: Route) => void
  onCreateWorkspace: () => void
  onSignOut: () => void
  onMobileNavToggle: () => void
  children: ReactNode
}

export function CloudShell({ route, title, user, workspaces, apiOnline, mobileNavOpen, docsSearch, showDocsSearch, onDocsSearch, onNavigate, onCreateWorkspace, onSignOut, onMobileNavToggle, children }: Props) {
  const selected = route.page === 'workspace' ? workspaces.find((workspace) => workspace.id === route.workspaceId) : null
  const initials = user.email.split('@')[0].split(/[._-]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A'
  const workspaceRoute = (workspaceId: string) => ({ page: 'workspace' as const, workspaceId, tab: 'overview' as const })
  return <div className="cloud-shell">
    {mobileNavOpen && <button type="button" className="mobile-nav-scrim" aria-label="Close menu" onClick={onMobileNavToggle} />}
    <aside className={`cloud-sidebar ${mobileNavOpen ? 'cloud-sidebar-open' : ''}`} aria-label="Main navigation">
      <button type="button" className="cloud-brand" onClick={() => onNavigate({ page: 'overview' })}>
        <span className="product-mark" aria-hidden="true"><span /><span /><span /></span>
        <span className="cloud-brand-name">API Documentation<small>Cloud workspace</small></span>
      </button>
      <nav className="sidebar-nav">
        <p className="nav-group-label">WORKSPACE</p>
        <button type="button" className={`sidebar-link ${route.page === 'overview' ? 'sidebar-link-active' : ''}`} aria-current={route.page === 'overview' ? 'page' : undefined} onClick={() => onNavigate({ page: 'overview' })}><SidebarIcon name="overview" />Overview</button>
        <button type="button" className={`sidebar-link ${route.page === 'workspaces' ? 'sidebar-link-active' : ''}`} aria-current={route.page === 'workspaces' ? 'page' : undefined} onClick={() => onNavigate({ page: 'workspaces' })}><SidebarIcon name="layers" />Workspaces<span className="sidebar-link-count">{workspaces.length}</span></button>
        <div className="nav-group-heading"><p className="nav-group-label">YOUR WORKSPACES</p><button type="button" className="sidebar-add" aria-label="Create workspace" onClick={onCreateWorkspace}>+</button></div>
        {workspaces.length ? <div className="sidebar-workspace-list">{workspaces.map((workspace) => <button key={workspace.id} type="button" title={workspace.name} className={`sidebar-link sidebar-workspace-link ${selected?.id === workspace.id ? 'sidebar-link-active' : ''}`} aria-current={selected?.id === workspace.id ? 'page' : undefined} onClick={() => onNavigate(workspaceRoute(workspace.id))}><span className="workspace-initial" aria-hidden="true">{workspace.name.trim().slice(0, 1).toUpperCase()}</span><span className="sidebar-workspace-name">{workspace.name}</span></button>)}</div> : <p className="sidebar-empty">Your workspace list will appear here.</p>}
      </nav>
      <footer className="sidebar-account">
        <span className="account-avatar" aria-hidden="true">{initials}</span>
        <span className="account-copy"><strong>{user.email.split('@')[0]}</strong><small>{user.email}</small></span>
        <button type="button" className="sign-out-button" onClick={onSignOut}>Sign out</button>
      </footer>
    </aside>
    <div className="cloud-main">
      <header className="cloud-topbar">
        <button type="button" className="mobile-menu-button" aria-expanded={mobileNavOpen} onClick={onMobileNavToggle}><SidebarIcon name="menu" />Menu</button>
        <div className="breadcrumbs"><button type="button" onClick={() => onNavigate({ page: 'overview' })}>Cloud</button><span aria-hidden="true">/</span><span>{selected ? selected.name : title}</span>{selected && route.tab && <><span aria-hidden="true">/</span><span>{route.tab === 'docs' ? 'API docs' : route.tab[0].toUpperCase() + route.tab.slice(1)}</span></>}</div>
        <div className="topbar-actions">
          {showDocsSearch && <label className="endpoint-search"><SidebarIcon name="search" /><input aria-label="Search endpoints" placeholder="Find an endpoint" value={docsSearch} onChange={(event) => onDocsSearch(event.target.value)} /></label>}
          <span className={`api-connection ${apiOnline === false ? 'api-connection-offline' : ''}`} role="status"><span className="connection-mark" />{apiOnline === null ? 'Checking API' : apiOnline ? 'API connected' : 'API unavailable'}</span>
        </div>
      </header>
      <main className="cloud-content">{children}</main>
    </div>
  </div>
}

function SidebarIcon({ name }: { name: 'overview' | 'layers' | 'menu' | 'search' }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="sidebar-icon">
    {name === 'overview' && <><rect x="3" y="3" width="5.5" height="5.5" rx="1" /><rect x="11.5" y="3" width="5.5" height="5.5" rx="1" /><rect x="3" y="11.5" width="5.5" height="5.5" rx="1" /><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1" /></>}
    {name === 'layers' && <><path d="m10 2.8 7 3.8-7 3.8-7-3.8 7-3.8Z" /><path d="m3 10 7 3.8 7-3.8M3 13.2l7 3.8 7-3.8" /></>}
    {name === 'menu' && <><path d="M3 5h14M3 10h14M3 15h14" /></>}
    {name === 'search' && <><circle cx="8.6" cy="8.6" r="5.4" /><path d="m12.6 12.6 4.1 4.1" /></>}
  </svg>
}
