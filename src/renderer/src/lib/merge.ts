export const bodyModes = ['form-data', 'urlencoded', 'graphql', 'json', 'xml', 'yaml', 'edn', 'text', 'other', 'file', 'none'] as const
export type BodyMode = typeof bodyModes[number]
export type BodyField = { id: string; name: string; value: string; enabled: boolean; type: 'text' | 'file'; filePath?: string; fileName?: string }
export type HeaderField = { id: string; name: string; value: string; enabled: boolean; description?: string }
export type ParamField = { id: string; name: string; value: string; enabled: boolean; description?: string }
export type RequestAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'api-key'; name: string; value: string; location: 'header' | 'query' }
export type ResponseContent = { id: string; mediaType: string; schema: string; example: string }
export type ResponseDefinition = { id: string; statusCode: string; description: string; content: ResponseContent[] }
export type SyncRequest = {
  id: string
  kind: 'request'
  name: string
  method: string
  url: string
  body: string
  bodyMode?: BodyMode
  bodyFields?: BodyField[]
  bodyVariables?: string
  bodyMimeType?: string
  bodyPath?: string
  bodyFileName?: string
  headers?: HeaderField[]
  params?: ParamField[]
  pathParams?: ParamField[]
  auth?: RequestAuth
  documentation?: string
  responses?: ResponseDefinition[]
  openApiSchemas?: Record<string, unknown>
  deprecated?: boolean
  deprecationReason?: string
}
export type SyncFolder = { id: string; kind: 'folder'; name: string; children: SyncTreeNode[] }
export type SyncTreeNode = SyncRequest | SyncFolder
export type SyncConflict = { id: string; local: SyncTreeNode | null; remote: SyncTreeNode | null }
type FlatNode = { node: SyncRequest | Omit<SyncFolder, 'children'>; parentId: string; order: number }

export function isBodyMode(value: unknown): value is BodyMode {
  return typeof value === 'string' && bodyModes.includes(value as BodyMode)
}

export function stripLocalFilePaths(tree: SyncTreeNode[]): SyncTreeNode[] {
  return tree.map((node) => {
    if (node.kind === 'folder') return { ...node, children: stripLocalFilePaths(node.children) }
    const { bodyPath: _bodyPath, ...request } = node
    return {
      ...request,
      ...(node.bodyFields ? { bodyFields: node.bodyFields.map(({ filePath: _filePath, ...field }) => field) } : {})
    }
  })
}

function comparableNode(node: FlatNode['node']): FlatNode['node'] {
  if (node.kind !== 'request') return node
  const { bodyPath: _bodyPath, ...request } = node
  return {
    ...request,
    ...(node.bodyFields ? { bodyFields: node.bodyFields.map(({ filePath: _filePath, ...field }) => field) } : {})
  }
}

function isFolder(node: SyncTreeNode): node is SyncFolder { return node.kind === 'folder' }

function flatten(tree: SyncTreeNode[]): Map<string, FlatNode> {
  const result = new Map<string, FlatNode>()
  function visit(nodes: SyncTreeNode[], parentId: string) {
    nodes.forEach((node, order) => {
      const flatNode = isFolder(node) ? { id: node.id, kind: node.kind, name: node.name } : node
      result.set(node.id, { node: flatNode, parentId, order })
      if (isFolder(node)) visit(node.children, node.id)
    })
  }
  visit(tree, '')
  return result
}

function sameState(left: FlatNode | undefined, right: FlatNode | undefined): boolean {
  if (!left || !right) return left === right
  return left.parentId === right.parentId && JSON.stringify(comparableNode(left.node)) === JSON.stringify(comparableNode(right.node))
}

export function mergeTreeSnapshots(
  baseTree: SyncTreeNode[],
  localTree: SyncTreeNode[],
  remoteTree: SyncTreeNode[],
  choices: Record<string, 'local' | 'remote'> = {}
): { tree: SyncTreeNode[]; conflicts: SyncConflict[]; unresolved: SyncConflict[] } {
  const base = flatten(baseTree)
  const local = flatten(localTree)
  const remote = flatten(remoteTree)
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()])
  const selected = new Map<string, FlatNode>()
  const conflicts: SyncConflict[] = []

  for (const id of ids) {
    const before = base.get(id)
    const mine = local.get(id)
    const theirs = remote.get(id)
    let choice: FlatNode | undefined
    if (!before) {
      if (mine && theirs && !sameState(mine, theirs)) {
        const conflict = { id, local: localTreeNode(mine, local), remote: localTreeNode(theirs, remote) }
        conflicts.push(conflict)
        choice = choices[id] === 'remote' ? theirs : mine
      } else choice = mine ?? theirs
    } else if (sameState(mine, before)) choice = theirs
    else if (sameState(theirs, before)) choice = mine
    else if (sameState(mine, theirs)) choice = mine
    else {
      const conflict = { id, local: mine ? localTreeNode(mine, local) : null, remote: theirs ? localTreeNode(theirs, remote) : null }
      conflicts.push(conflict)
      choice = choices[id] === 'remote' ? theirs : mine
    }
    if (choice) selected.set(id, choice)
  }

  const unresolved = conflicts.filter((conflict) => !choices[conflict.id])
  const childrenByParent = new Map<string, Array<[string, FlatNode]>>()
  for (const [id, entry] of selected) {
    const parentId = entry.parentId && selected.has(entry.parentId) ? entry.parentId : ''
    const children = childrenByParent.get(parentId) ?? []
    children.push([id, entry])
    childrenByParent.set(parentId, children)
  }

  function build(parentId: string, path = new Set<string>()): SyncTreeNode[] {
    return (childrenByParent.get(parentId) ?? [])
      .sort((a, b) => a[1].order - b[1].order)
      .map(([id, entry]) => {
        if (entry.node.kind === 'request') return entry.node
        if (path.has(id)) return { ...entry.node, children: [] }
        const nextPath = new Set(path).add(id)
        return { ...entry.node, children: build(id, nextPath) }
      })
  }

  return { tree: build(''), conflicts, unresolved }
}

function localTreeNode(entry: FlatNode, source: Map<string, FlatNode>): SyncTreeNode {
  if (entry.node.kind === 'request') return entry.node
  const children = [...source.entries()]
    .filter(([, child]) => child.parentId === entry.node.id)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([, child]) => localTreeNode(child, source))
  return { ...entry.node, children }
}
