export type WorkspaceRole = 'owner' | 'editor' | 'viewer'

export type CloudWorkspaceRef = {
  id: string
  name: string
  role: WorkspaceRole
  headCommitId: string | null
  createdAt: string
  updatedAt: string | null
}

export type RequestNode = {
  id: string
  kind: 'request'
  name: string
  method: string
  url: string
  body: string
  bodyMode?: string
  bodyFields?: Array<{ id: string; name: string; value: string; enabled: boolean; type: 'text' | 'file'; fileName?: string }>
  bodyVariables?: string
  bodyMimeType?: string
  headers?: Array<{ id: string; name: string; value: string; enabled: boolean; description?: string }>
  params?: Array<{ id: string; name: string; value: string; enabled: boolean; description?: string }>
  pathParams?: Array<{ id: string; name: string; value: string; enabled: boolean; description?: string }>
  auth?: { type: 'none' } | { type: 'bearer'; token: string } | { type: 'basic'; username: string; password: string } | { type: 'api-key'; name: string; value: string; location: 'header' | 'query' }
  documentation?: string
  responses?: Array<{ id: string; statusCode: string; description: string; content: Array<{ id: string; mediaType: string; schema: string; example: string }> }>
  deprecated?: boolean
  deprecationReason?: string
}

export type FolderNode = { id: string; kind: 'folder'; name: string; children: ApiNode[] }
export type ApiNode = RequestNode | FolderNode

export type WorkspaceSnapshot = CloudWorkspaceRef & {
  tree: ApiNode[]
  variables?: { globals: unknown[]; environments: unknown[] }
  parentIds?: string[]
  message?: string
}

export type CloudCommit = { id: string; parentIds: string[]; message: string; createdAt: string; authorEmail: string }
export type CloudMember = { id: string; email: string; role: WorkspaceRole; joinedAt: string }
export type CloudInvite = { id: string; email: string; role: 'editor' | 'viewer'; expiresAt: string; createdAt: string; createdByEmail: string }
export type CloudUser = { id: string; email: string }
