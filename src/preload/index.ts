import { contextBridge, ipcRenderer } from 'electron'
import type { WorkspaceVariables } from '../renderer/src/lib/workspace-variables'

let pendingInviteToken: string | null = null
const inviteHandlers = new Set<(token: string) => void>()

ipcRenderer.on('invite:token', (_event, token: string) => {
  pendingInviteToken = token
  inviteHandlers.forEach((handler) => handler(token))
  if (inviteHandlers.size) pendingInviteToken = null
})

type UpdateStatus =
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; version: string; message: string }
const updateHandlers = new Set<(status: UpdateStatus) => void>()
ipcRenderer.on('update:status', (_event, status: UpdateStatus) => updateHandlers.forEach((handler) => handler(status)))

let pendingAuthCode: string | null = null
const authCodeHandlers = new Set<(code: string) => void>()

ipcRenderer.on('auth:code', (_event, code: string) => {
  pendingAuthCode = code
  authCodeHandlers.forEach((handler) => handler(code))
  if (authCodeHandlers.size) pendingAuthCode = null
})

contextBridge.exposeInMainWorld('apiDesktop', {
  sendRequest: (request: ApiRequest) => ipcRenderer.invoke('request:send', request),
  selectFile: () => ipcRenderer.invoke('file:select') as Promise<{ path: string; name: string } | null>,
  loadWorkspace: (legacyTree: unknown[]) => ipcRenderer.invoke('workspace:load', legacyTree),
  saveWorkspace: (workspace: LocalWorkspace) => ipcRenderer.invoke('workspace:save', workspace) as Promise<boolean>,
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  onExternalWorkspaceChange: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('workspace:external-change', listener)
    return () => ipcRenderer.removeListener('workspace:external-change', listener)
  },
  secureStorageAvailable: () => ipcRenderer.invoke('secret:available') as Promise<boolean>,
  saveCommit: (workspaceId: string, commit: LocalCommit) => ipcRenderer.invoke('commit:save', workspaceId, commit),
  listCommits: (workspaceId: string) => ipcRenderer.invoke('commit:list', workspaceId),
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (token: string) => ipcRenderer.invoke('session:save', token),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  onInviteToken: (handler: (token: string) => void) => {
    inviteHandlers.add(handler)
    if (pendingInviteToken) {
      handler(pendingInviteToken)
      pendingInviteToken = null
    }
    return () => inviteHandlers.delete(handler)
  },
  downloadUpdate: (version: string) => ipcRenderer.invoke('update:download', version) as Promise<void>,
  onUpdateStatus: (handler: (status: UpdateStatus) => void) => {
    updateHandlers.add(handler)
    void ipcRenderer.invoke('update:latest').then((status: UpdateStatus | null) => { if (status) handler(status) })
    return () => updateHandlers.delete(handler)
  },
  beginBrowserSignIn: (cloudUrl: string) => ipcRenderer.invoke('auth:begin', cloudUrl) as Promise<void>,
  onAuthCode: (handler: (code: string) => void) => {
    authCodeHandlers.add(handler)
    if (pendingAuthCode) {
      handler(pendingAuthCode)
      pendingAuthCode = null
    }
    return () => authCodeHandlers.delete(handler)
  }
})

export type LocalWorkspace = {
  id: string
  cloudId: string | null
  name: string
  tree: unknown[]
  baseTree: unknown[]
  variables?: WorkspaceVariables
  baseVariables?: WorkspaceVariables
  activeEnvironmentId?: string | null
  baseCommitId: string | null
  localHeadId: string | null
  role?: 'owner' | 'editor' | 'viewer' | null
}

export type LocalCommit = {
  id: string
  parentIds: string[]
  message: string
  tree: unknown[]
  variables?: WorkspaceVariables
  createdAt: string
  pushed: boolean
}

export type ApiRequest = {
  method: string
  url: string
  headers: Array<{ name: string; value: string; enabled: boolean }>
  params?: Array<{ id: string; name: string; value: string; enabled: boolean; description?: string }>
  auth?: { type: 'none' } | { type: 'bearer'; token: string } | { type: 'basic'; username: string; password: string } | { type: 'api-key'; name: string; value: string; location: 'header' | 'query' }
  body?: string
  bodyMode?: 'form-data' | 'urlencoded' | 'graphql' | 'json' | 'xml' | 'yaml' | 'edn' | 'text' | 'other' | 'file' | 'none'
  bodyFields?: Array<{ id: string; name: string; value: string; enabled: boolean; type: 'text' | 'file'; filePath?: string; fileName?: string }>
  bodyVariables?: string
  bodyMimeType?: string
  bodyPath?: string
  bodyFileName?: string
}

export type ApiResponse = {
  status: number
  statusText: string
  duration: number
  headers: Record<string, string>
  body: string
}
