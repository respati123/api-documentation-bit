import type { SyncFolder, SyncRequest, SyncTreeNode } from './merge'
import { emptyWorkspaceVariables, shareableWorkspaceVariables, workspaceVariablesChangeId, type WorkspaceVariables } from './workspace-variables'

export type ChangeStatus = 'added' | 'modified' | 'deleted'
export type WorkspaceChange = { id: string; name: string; status: ChangeStatus }
type FlatResource = Omit<SyncFolder, 'children'> | SyncRequest
type FlatNode = { node: FlatResource; parentId: string; order: number }
const nodeSignatures = new WeakMap<FlatResource, string>()

function nodeSignature(node: FlatResource): string {
  const cached = nodeSignatures.get(node)
  if (cached !== undefined) return cached
  const signature = JSON.stringify(comparableNode(node))
  nodeSignatures.set(node, signature)
  return signature
}

function flatten(tree: SyncTreeNode[]) {
  const entries = new Map<string, FlatNode>()
  function visit(nodes: SyncTreeNode[], parentId: string) {
    nodes.forEach((node, order) => {
      const flatNode: FlatResource = node.kind === 'folder' ? { id: node.id, kind: 'folder', name: node.name } : node
      entries.set(node.id, { node: flatNode, parentId, order })
      if (node.kind === 'folder') visit(node.children, node.id)
    })
  }
  visit(tree, '')
  return entries
}

function sameEntry(left: FlatNode | undefined, right: FlatNode | undefined) {
  if (!left || !right) return left === right
  return left.parentId === right.parentId && left.order === right.order && (left.node === right.node || nodeSignature(left.node) === nodeSignature(right.node))
}

function comparableNode(node: FlatResource): FlatResource {
  if (node.kind !== 'request') return node
  const { bodyPath: _bodyPath, ...request } = node
  return { ...request, ...(node.bodyFields ? { bodyFields: node.bodyFields.map(({ filePath: _filePath, ...field }) => field) } : {}) }
}

export function getWorkspaceChanges(
  baseTree: SyncTreeNode[],
  workingTree: SyncTreeNode[],
  baseVariables: WorkspaceVariables = emptyWorkspaceVariables(),
  workingVariables: WorkspaceVariables = emptyWorkspaceVariables()
): WorkspaceChange[] {
  const base = flatten(baseTree)
  const working = flatten(workingTree)
  const changes: WorkspaceChange[] = []
  for (const id of new Set([...base.keys(), ...working.keys()])) {
    const before = base.get(id)
    const after = working.get(id)
    if (sameEntry(before, after)) continue
    const node = after?.node ?? before?.node
    if (!node) continue
    changes.push({ id, name: node.name, status: !before ? 'added' : !after ? 'deleted' : 'modified' })
  }
  if (JSON.stringify(shareableWorkspaceVariables(baseVariables)) !== JSON.stringify(shareableWorkspaceVariables(workingVariables))) {
    changes.push({ id: workspaceVariablesChangeId, name: 'Workspace variables', status: 'modified' })
  }
  return changes
}

export function buildStagedSnapshot(baseTree: SyncTreeNode[], workingTree: SyncTreeNode[], stagedIds: Set<string>): SyncTreeNode[] {
  const base = flatten(baseTree)
  const working = flatten(workingTree)
  const selected = new Map(base)
  for (const id of stagedIds) {
    const entry = working.get(id)
    if (entry) selected.set(id, entry)
    else selected.delete(id)
  }

  const childrenByParent = new Map<string, Array<[string, FlatNode]>>()
  for (const [id, entry] of selected) {
    const parentId = entry.parentId && selected.has(entry.parentId) ? entry.parentId : ''
    const children = childrenByParent.get(parentId) ?? []
    children.push([id, entry])
    childrenByParent.set(parentId, children)
  }

  function build(parentId: string): SyncTreeNode[] {
    return (childrenByParent.get(parentId) ?? []).sort((a, b) => a[1].order - b[1].order).map(([, entry]) => {
      if (entry.node.kind === 'request') return entry.node
      return { ...entry.node, children: build(entry.node.id) }
    })
  }
  return build('')
}
