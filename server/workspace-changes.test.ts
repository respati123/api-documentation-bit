import { describe, expect, test } from 'bun:test'
import type { SyncTreeNode } from '../src/renderer/src/lib/merge'
import { buildStagedSnapshot, getWorkspaceChanges } from '../src/renderer/src/lib/workspace-changes'

const base: SyncTreeNode[] = [{ id: 'folder', kind: 'folder', name: 'API', children: [
  { id: 'one', kind: 'request', name: 'One', method: 'GET', url: '/one', body: '' },
  { id: 'two', kind: 'request', name: 'Two', method: 'GET', url: '/two', body: '' }
] }]

describe('workspace change states', () => {
  test('reports added, modified, and deleted nodes', () => {
    const working = structuredClone(base)
    if (working[0].kind !== 'folder') throw new Error('Expected folder')
    const request = working[0].children[0]
    if (request.kind !== 'request') throw new Error('Expected request')
    request.url = '/updated'
    working[0].children = [request, { id: 'new', kind: 'request', name: 'New', method: 'POST', url: '/new', body: '{}' }]
    expect(getWorkspaceChanges(base, working)).toEqual([
      { id: 'one', name: 'One', status: 'modified' },
      { id: 'two', name: 'Two', status: 'deleted' },
      { id: 'new', name: 'New', status: 'added' }
    ])
  })

  test('commits only staged changes and leaves unstaged edits out of the snapshot', () => {
    const working = structuredClone(base)
    if (working[0].kind !== 'folder') throw new Error('Expected folder')
    const first = working[0].children[0]
    const second = working[0].children[1]
    if (first.kind !== 'request' || second.kind !== 'request') throw new Error('Expected requests')
    first.url = '/staged'
    second.url = '/unstaged'
    const snapshot = buildStagedSnapshot(base, working, new Set(['one']))
    if (snapshot[0].kind !== 'folder') throw new Error('Expected folder')
    expect(snapshot[0].children.map((node) => node.kind === 'request' ? node.url : '')).toEqual(['/staged', '/two'])
  })
})
