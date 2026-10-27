/// <reference types="vite/client" />

type ApiRequest = {
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

type ApiResponse = {
  status: number
  statusText: string
  duration: number
  headers: Record<string, string>
  cookies?: string[]
  body: string
}

type LocalWorkspace = {
  id: string
  cloudId: string | null
  name: string
  tree: unknown[]
  baseTree: unknown[]
  variables?: import('./lib/workspace-variables').WorkspaceVariables
  baseVariables?: import('./lib/workspace-variables').WorkspaceVariables
  activeEnvironmentId?: string | null
  baseCommitId: string | null
  localHeadId: string | null
  role?: 'owner' | 'editor' | 'viewer' | null
}

type LocalCommit = {
  id: string
  parentIds: string[]
  message: string
  tree: unknown[]
  variables?: import('./lib/workspace-variables').WorkspaceVariables
  createdAt: string
  pushed: boolean
}

type AiToolId = 'codex' | 'claude-cli' | 'claude-desktop'
type AiConnectStatus = {
  node: { installed: boolean; version?: string }
  tools: Array<{ id: AiToolId; supported: boolean; installed: boolean; connected: boolean }>
}
type NodeInstallProgress = { stage: 'checking' | 'downloading' | 'verifying' | 'extracting' | 'done'; percent?: number }

interface Window {
  apiDesktop: {
    sendRequest(request: ApiRequest): Promise<ApiResponse>
    selectFile(): Promise<{ path: string; name: string } | null>
    loadWorkspace(legacyTree: unknown[]): Promise<LocalWorkspace>
    saveWorkspace(workspace: LocalWorkspace): Promise<boolean>
    listWorkspaces(): Promise<LocalWorkspace[]>
    onExternalWorkspaceChange(handler: () => void): () => void
    secureStorageAvailable(): Promise<boolean>
    saveCommit(workspaceId: string, commit: LocalCommit): Promise<void>
    listCommits(workspaceId: string): Promise<LocalCommit[]>
    loadSession(): Promise<string | null>
    saveSession(token: string): Promise<boolean>
    clearSession(): Promise<void>
    onInviteToken(handler: (token: string) => void): () => void
    beginBrowserSignIn(cloudUrl: string): Promise<void>
    downloadUpdate(version: string): Promise<void>
    aiStatus(): Promise<AiConnectStatus>
    installNodeRuntime(): Promise<string | null>
    installAiTool(id: 'codex' | 'claude-cli'): Promise<void>
    connectAiTool(id: AiToolId): Promise<void>
    onNodeProgress(handler: (progress: NodeInstallProgress) => void): () => void
    onAiLog(handler: (line: string) => void): () => void
    onConnectAiMenu(handler: () => void): () => void
    onUpdateStatus(handler: (status: { state: 'available'; version: string } | { state: 'downloading'; version: string; percent: number } | { state: 'downloaded'; version: string } | { state: 'error'; version: string; message: string }) => void): () => void
    onAuthCode(handler: (code: string) => void): () => void
  }
}
