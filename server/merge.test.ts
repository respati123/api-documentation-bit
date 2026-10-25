import { describe, expect, test } from 'bun:test'
import { mergeTreeSnapshots, type SyncTreeNode } from '../src/renderer/src/lib/merge'

const base: SyncTreeNode[] = [{ id: 'folder', kind: 'folder', name: 'API', children: [
  { id: 'get', kind: 'request', name: 'Get item', method: 'GET', url: '/item', body: '' },
  { id: 'post', kind: 'request', name: 'Create item', method: 'POST', url: '/item', body: '{}' }
] }]

describe('mergeTreeSnapshots', () => {
  test('automatically combines changes to separate requests', () => {
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const localFolder = local[0]
    const remoteFolder = remote[0]
    if (localFolder.kind !== 'folder' || remoteFolder.kind !== 'folder') throw new Error('Expected folders')
    localFolder.children[0].name = 'Get one item'
    const changedRequest = remoteFolder.children[1]
    if (changedRequest.kind !== 'request') throw new Error('Expected a request')
    changedRequest.url = '/items'
    const result = mergeTreeSnapshots(base, local, remote)
    const folder = result.tree[0]
    expect(result.unresolved).toHaveLength(0)
    if (folder.kind !== 'folder') throw new Error('Expected a folder')
    expect(folder.children[0].name).toBe('Get one item')
    const mergedRequest = folder.children[1]
    expect(mergedRequest.kind === 'request' && mergedRequest.url).toBe('/items')
  })

  test('reports a same-request conflict and accepts the remote choice', () => {
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const localFolder = local[0]
    const remoteFolder = remote[0]
    if (localFolder.kind !== 'folder' || remoteFolder.kind !== 'folder') throw new Error('Expected folders')
    localFolder.children[0].name = 'Local name'
    remoteFolder.children[0].name = 'Cloud name'
    const unresolved = mergeTreeSnapshots(base, local, remote)
    expect(unresolved.unresolved.map((item) => item.id)).toEqual(['get'])
    const resolved = mergeTreeSnapshots(base, local, remote, { get: 'remote' })
    const folder = resolved.tree[0]
    if (folder.kind !== 'folder') throw new Error('Expected a folder')
    expect(folder.children[0].name).toBe('Cloud name')
    expect(resolved.unresolved).toHaveLength(0)
  })

  test('reports edit versus delete as a conflict', () => {
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const localFolder = local[0]
    const remoteFolder = remote[0]
    if (localFolder.kind !== 'folder' || remoteFolder.kind !== 'folder') throw new Error('Expected folders')
    localFolder.children[0].name = 'Updated locally'
    remoteFolder.children = remoteFolder.children.filter((item) => item.id !== 'get')
    const result = mergeTreeSnapshots(base, local, remote)
    expect(result.unresolved.map((item) => item.id)).toEqual(['get'])
    expect(result.conflicts[0].local?.id).toBe('get')
    expect(result.conflicts[0].remote).toBeNull()
  })
})
