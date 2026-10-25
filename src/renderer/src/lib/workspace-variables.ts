import type { SyncRequest } from './merge'

export type WorkspaceVariable = {
  id: string
  name: string
  value: string
  secret: boolean
}

export type WorkspaceEnvironment = {
  id: string
  name: string
  variables: WorkspaceVariable[]
}

export type WorkspaceVariables = {
  globals: WorkspaceVariable[]
  environments: WorkspaceEnvironment[]
}

export const workspaceVariablesChangeId = '__workspace_variables__'

export function emptyWorkspaceVariables(): WorkspaceVariables {
  return { globals: [], environments: [] }
}

export function normalizeWorkspaceVariables(value: unknown): WorkspaceVariables {
  if (!value || typeof value !== 'object') return emptyWorkspaceVariables()
  const candidate = value as Record<string, unknown>
  const normalizeRows = (rows: unknown): WorkspaceVariable[] => Array.isArray(rows) ? rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.value !== 'string') return []
    return [{ id: item.id, name: item.name, value: item.value, secret: item.secret === true }]
  }) : []
  const environments = Array.isArray(candidate.environments) ? candidate.environments.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.name !== 'string') return []
    return [{ id: item.id, name: item.name, variables: normalizeRows(item.variables) }]
  }) : []
  return { globals: normalizeRows(candidate.globals), environments }
}

export function shareableWorkspaceVariables(value: WorkspaceVariables): WorkspaceVariables {
  return {
    globals: value.globals.map((variable) => ({ ...variable, value: variable.secret ? '' : variable.value })),
    environments: value.environments.map((environment) => ({
      ...environment,
      variables: environment.variables.map((variable) => ({ ...variable, value: variable.secret ? '' : variable.value }))
    }))
  }
}

export function preserveLocalSecretValues(shared: WorkspaceVariables, local: WorkspaceVariables): WorkspaceVariables {
  const localValues = new Map<string, string>()
  for (const variable of [...local.globals, ...local.environments.flatMap((environment) => environment.variables)]) {
    if (variable.secret) localValues.set(variable.id, variable.value)
  }
  const restore = (variable: WorkspaceVariable) => variable.secret && localValues.has(variable.id)
    ? { ...variable, value: localValues.get(variable.id) ?? '' }
    : variable
  return {
    globals: shared.globals.map(restore),
    environments: shared.environments.map((environment) => ({ ...environment, variables: environment.variables.map(restore) }))
  }
}

export function activeVariableValues(value: WorkspaceVariables, environmentId: string | null): Record<string, string> {
  const values: Record<string, string> = {}
  for (const variable of value.globals) if (variable.name.trim()) values[variable.name.trim()] = variable.value
  const environment = value.environments.find((item) => item.id === environmentId)
  for (const variable of environment?.variables ?? []) if (variable.name.trim()) values[variable.name.trim()] = variable.value
  return values
}

export function resolveRequestVariables<T extends SyncRequest>(request: T, values: Record<string, string>): T {
  const replace = (value: string) => value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName: string) => {
    const name = rawName.trim()
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`Variable "{{${name}}}" is not defined in the global scope or active environment.`)
    return values[name]
  })
  const auth = request.auth && request.auth.type !== 'none'
    ? Object.fromEntries(Object.entries(request.auth).map(([key, value]) => [key, typeof value === 'string' && key !== 'type' && key !== 'location' ? replace(value) : value])) as T['auth']
    : request.auth
  const bodyMode = request.bodyMode ?? (request.body.trim() ? 'json' : 'none')
  const sendsBody = !['GET', 'HEAD'].includes(request.method.toUpperCase()) && bodyMode !== 'none'
  return {
    ...request,
    url: replace(request.url),
    headers: request.headers?.map((header) => header.enabled ? ({ ...header, name: replace(header.name), value: replace(header.value) }) : header),
    params: request.params?.map((param) => param.enabled ? ({ ...param, name: replace(param.name), value: replace(param.value) }) : param),
    auth,
    body: sendsBody ? replace(request.body) : request.body,
    bodyFields: request.bodyFields?.map((field) => sendsBody && field.enabled ? ({ ...field, name: replace(field.name), value: replace(field.value) }) : field),
    bodyVariables: request.bodyVariables === undefined || bodyMode !== 'graphql' || !sendsBody ? request.bodyVariables : replace(request.bodyVariables),
    bodyMimeType: request.bodyMimeType === undefined || !sendsBody || !['file', 'other'].includes(bodyMode) ? request.bodyMimeType : replace(request.bodyMimeType)
  }
}

export function mergeWorkspaceVariables(
  base: WorkspaceVariables,
  local: WorkspaceVariables,
  remote: WorkspaceVariables,
  choice?: 'local' | 'remote'
): { variables: WorkspaceVariables; conflict: boolean } {
  const sharedBase = shareableWorkspaceVariables(base)
  const sharedLocal = shareableWorkspaceVariables(local)
  const sharedRemote = shareableWorkspaceVariables(remote)
  const same = (left: WorkspaceVariables, right: WorkspaceVariables) => JSON.stringify(left) === JSON.stringify(right)
  const conflict = !same(sharedLocal, sharedBase) && !same(sharedRemote, sharedBase) && !same(sharedLocal, sharedRemote)
  const selected = same(sharedLocal, sharedBase) ? sharedRemote
    : same(sharedRemote, sharedBase) || same(sharedLocal, sharedRemote) || choice !== 'remote' ? sharedLocal
      : sharedRemote
  return { variables: preserveLocalSecretValues(selected, local), conflict }
}

export function workspaceVariablesDiffText(value: WorkspaceVariables | undefined): string {
  return JSON.stringify(shareableWorkspaceVariables(value ?? emptyWorkspaceVariables()), null, 2)
}
