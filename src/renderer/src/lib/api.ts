import type { WorkspaceVariables } from './workspace-variables'

const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export function apiWebSocketUrl(path: string): string {
  const url = new URL(path, apiBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export type ApiUser = { id: string; email: string }
export type CloudWorkspace = { id: string; name: string; role: 'owner' | 'editor' | 'viewer'; headCommitId: string; tree?: unknown[]; variables?: WorkspaceVariables }
export type CloudCommit = { id: string; parentIds: string[]; message: string; createdAt: string }
export type CloudCommitDetail = CloudCommit & { tree: unknown[]; variables?: WorkspaceVariables }

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: unknown) { super(message) }
}

export async function apiCall<T>(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const result = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new ApiError(result.error || `API request failed (${response.status}).`, response.status, result)
  return result
}

