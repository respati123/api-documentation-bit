import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { WorkspaceVariables } from '../renderer/src/lib/workspace-variables'
import { startLoopbackSignIn, type LoopbackSignIn } from './loopback-auth'
import updaterModule from 'electron-updater'

// electron-updater is CommonJS; named imports fail when Electron loads the ESM main bundle.
const { autoUpdater } = updaterModule

type UpdateStatus =
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }

// Required for app.on('second-instance') to fire on Windows/Linux when the app
// is already running and the OS re-invokes it through the api-docs:// protocol
// (invite links).
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

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

type LocalWorkspace = {
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

let localDatabase: DatabaseSync | undefined
let mainWindow: BrowserWindow | undefined
let pendingInviteToken: string | undefined
let activeSignIn: LoopbackSignIn | undefined

// Handles api-docs://invite?token=... links.
function receiveInviteLink(link: string): void {
  try {
    const token = new URL(link).searchParams.get('token')
    if (!token) return
    pendingInviteToken = token
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('invite:token', token)
      pendingInviteToken = undefined
    }
  } catch { /* Ignore unrelated protocol links. */ }
}

function database(): DatabaseSync {
  if (!localDatabase) {
    localDatabase = new DatabaseSync(join(app.getPath('userData'), 'workspace.sqlite'))
    localDatabase.exec('PRAGMA busy_timeout = 5000;')
    localDatabase.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commits (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    `)
  }
  return localDatabase
}

let databaseWatchTimer: NodeJS.Timeout | undefined
function watchExternalWorkspaceChanges(): void {
  if (databaseWatchTimer) return
  const db = database()
  let observedVersion = Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
  databaseWatchTimer = setInterval(() => {
    try {
      const currentVersion = Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
      if (currentVersion === observedVersion) return
      observedVersion = currentVersion
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:external-change')
    } catch (error) {
      console.error('Could not check for external workspace changes:', error)
    }
  }, 500)
  databaseWatchTimer.unref()
}

function stripSecretVariableValues(value: WorkspaceVariables | undefined): WorkspaceVariables {
  const variables = value ?? { globals: [], environments: [] }
  const cleanRows = (rows: WorkspaceVariables['globals']) => rows.map((item) => ({ ...item, value: item.secret ? '' : item.value }))
  return {
    globals: cleanRows(variables.globals),
    environments: variables.environments.map((environment) => ({ ...environment, variables: cleanRows(environment.variables) }))
  }
}

function restoreSecretVariableValues(workspaceId: string, value: WorkspaceVariables | undefined): WorkspaceVariables {
  const variables = value ?? { globals: [], environments: [] }
  if (!safeStorage.isEncryptionAvailable()) return variables
  const restoreRows = (rows: WorkspaceVariables['globals']) => rows.map((item) => {
    if (!item.secret) return item
    const key = `workspace-variable:${workspaceId}:${item.id}`
    const row = database().prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: Uint8Array } | undefined
    return row ? { ...item, value: safeStorage.decryptString(Buffer.from(row.value)) } : item
  })
  return {
    globals: restoreRows(variables.globals),
    environments: variables.environments.map((environment) => ({ ...environment, variables: restoreRows(environment.variables) }))
  }
}

function persistWorkspace(workspace: LocalWorkspace): boolean {
  const db = database()
  const variables = workspace.variables ?? { globals: [], environments: [] }
  const secretRows = [...variables.globals, ...variables.environments.flatMap((environment) => environment.variables)].filter((item) => item.secret)
  const canEncrypt = safeStorage.isEncryptionAvailable()
  const prefix = `workspace-variable:${workspace.id}:`
  const activeKeys = new Set(secretRows.map((item) => `${prefix}${item.id}`))
  const existing = db.prepare('SELECT key FROM secrets').all() as { key: string }[]
  for (const row of existing) if (row.key.startsWith(prefix) && !activeKeys.has(row.key)) db.prepare('DELETE FROM secrets WHERE key = ?').run(row.key)
  if (canEncrypt) {
    for (const item of secretRows) {
      const key = `${prefix}${item.id}`
      if (!item.value) db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
      else {
        const encrypted = safeStorage.encryptString(item.value)
        db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, encrypted)
      }
    }
  }
  const stored = {
    ...workspace,
    variables: stripSecretVariableValues(variables),
    baseVariables: stripSecretVariableValues(workspace.baseVariables)
  }
  db.prepare('INSERT INTO workspaces (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(workspace.id, JSON.stringify(stored))
  return canEncrypt || secretRows.every((item) => !item.value)
}

function loadWorkspaceData(value: string): LocalWorkspace {
  const workspace = JSON.parse(value) as LocalWorkspace
  return { ...workspace, variables: restoreSecretVariableValues(workspace.id, workspace.variables) }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window
  // Check again when the user brings the app back to the front.
  window.on('focus', () => checkForUpdatesNow?.())
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  window.webContents.once('did-finish-load', () => {
    if (pendingInviteToken) {
      window.webContents.send('invite:token', pendingInviteToken)
      pendingInviteToken = undefined
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('request:send', async (_event, request: ApiRequest) => {
  const startedAt = performance.now()
  const targetUrl = new URL(request.url)
  if (request.params !== undefined) targetUrl.search = ''
  for (const param of request.params ?? []) {
    if (param.enabled && param.name.trim()) targetUrl.searchParams.append(param.name, param.value)
  }
  const headers = new Headers()
  for (const header of request.headers ?? []) {
    if (header.enabled && header.name.trim()) headers.append(header.name.trim(), header.value)
  }
  if (!headers.has('Accept')) headers.set('Accept', '*/*')
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'API-Documentation/0.1.0')
  const auth = request.auth ?? { type: 'none' as const }
  if (auth.type === 'bearer' && auth.token) headers.set('Authorization', `Bearer ${auth.token}`)
  if (auth.type === 'basic' && (auth.username || auth.password)) headers.set('Authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`)
  if (auth.type === 'api-key' && auth.name.trim() && auth.value) {
    if (auth.location === 'query') targetUrl.searchParams.append(auth.name, auth.value)
    else headers.set(auth.name, auth.value)
  }
  const mode = request.bodyMode ?? (request.body?.trim() ? 'json' : 'none')
  let requestBody: BodyInit | undefined
  const canSendBody = !['GET', 'HEAD'].includes(request.method.toUpperCase()) && mode !== 'none'
  if (mode !== 'none' && !(mode === 'form-data' && canSendBody) && !headers.has('Content-Type')) {
    const contentType = mode === 'form-data' ? 'multipart/form-data'
      : mode === 'urlencoded' ? 'application/x-www-form-urlencoded;charset=UTF-8'
        : mode === 'file' ? request.bodyMimeType || 'application/octet-stream'
          : mode === 'other' ? request.bodyMimeType || 'text/plain'
            : mode === 'graphql' || mode === 'json' ? 'application/json'
              : mode === 'xml' ? 'application/xml'
                : mode === 'yaml' ? 'application/yaml'
                  : mode === 'edn' ? 'application/edn' : 'text/plain'
    headers.set('Content-Type', contentType)
  }

  if (canSendBody) {
    if (mode === 'form-data') {
      const form = new FormData()
      for (const field of request.bodyFields ?? []) {
        if (!field.enabled || !field.name) continue
        if (field.type === 'file') {
          if (!field.filePath) throw new Error(`Choose a file for the "${field.name}" field before sending.`)
          const bytes = new Uint8Array(await readFile(field.filePath))
          form.append(field.name, new Blob([bytes]), field.fileName || basename(field.filePath))
        } else form.append(field.name, field.value)
      }
      headers.delete('Content-Type')
      requestBody = form
    } else if (mode === 'urlencoded') {
      const form = new URLSearchParams()
      for (const field of request.bodyFields ?? []) if (field.enabled && field.name) form.append(field.name, field.value)
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8')
      requestBody = form
    } else if (mode === 'file') {
      if (!request.bodyPath) throw new Error('Choose a file before sending this request.')
      if (!headers.has('Content-Type')) headers.set('Content-Type', request.bodyMimeType || 'application/octet-stream')
      requestBody = new Uint8Array(await readFile(request.bodyPath))
    } else if (mode === 'graphql') {
      let variables: unknown = {}
      try { variables = JSON.parse(request.bodyVariables || '{}') } catch { throw new Error('GraphQL variables must contain valid JSON.') }
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      requestBody = JSON.stringify({ query: request.body ?? '', variables })
    } else {
      const contentType = mode === 'other'
        ? request.bodyMimeType || 'text/plain'
        : mode === 'json' ? 'application/json'
          : mode === 'xml' ? 'application/xml'
            : mode === 'yaml' ? 'application/yaml'
              : mode === 'edn' ? 'application/edn'
                : 'text/plain'
      if (!headers.has('Content-Type')) headers.set('Content-Type', contentType)
      requestBody = request.body ?? ''
    }
  }

  let response: Response
  try {
    response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: requestBody
    })
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined
    const details = cause && typeof cause === 'object' ? cause as { code?: string; message?: string } : undefined
    const code = details?.code
    const reason = code === 'ECONNREFUSED' ? 'The server refused the connection. Check that the API is running and the host and port are correct.'
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'The hostname could not be resolved. Check the URL and network connection.'
        : code === 'ETIMEDOUT' ? 'The connection timed out. Check the server and network.'
          : code?.startsWith('CERT_') || code?.startsWith('ERR_TLS_') ? 'The TLS certificate could not be verified.'
            : details?.message || (error instanceof Error ? error.message : 'Unknown network error.')
    throw new Error(`Could not reach ${targetUrl.origin}. ${reason}${code ? ` (${code})` : ''}`)
  }
  const body = await response.text()

  return {
    status: response.status,
    statusText: response.statusText,
    duration: Math.round(performance.now() - startedAt),
    headers: Object.fromEntries(response.headers.entries()),
    cookies: typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []),
    body
  }
})

ipcMain.handle('file:select', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] })
  const path = result.filePaths[0]
  return result.canceled || !path ? null : { path, name: basename(path) }
})

ipcMain.handle('workspace:load', (_event, legacyTree: unknown[]) => {
  const db = database()
  const saved = db.prepare('SELECT data FROM workspaces WHERE id = ?').get('local-default') as { data: string } | undefined
  if (saved) return loadWorkspaceData(saved.data)
  const tree = Array.isArray(legacyTree) ? legacyTree : []
  const variables = { globals: [], environments: [] }
  const workspace: LocalWorkspace = { id: 'local-default', cloudId: null, name: 'My workspace', tree, baseTree: tree, variables, baseVariables: variables, activeEnvironmentId: null, baseCommitId: null, localHeadId: null }
  db.prepare('INSERT INTO workspaces (id, data) VALUES (?, ?)').run(workspace.id, JSON.stringify(workspace))
  return workspace
})

ipcMain.handle('workspace:save', (_event, workspace: LocalWorkspace) => {
  if (!workspace || typeof workspace.id !== 'string' || !Array.isArray(workspace.tree) || !Array.isArray(workspace.baseTree)) {
    throw new TypeError('Invalid workspace data.')
  }
  return persistWorkspace(workspace)
})

ipcMain.handle('workspace:list', () => {
  return (database().prepare('SELECT data FROM workspaces ORDER BY rowid').all() as { data: string }[]).map((row) => loadWorkspaceData(row.data))
})

ipcMain.handle('commit:save', (_event, workspaceId: string, commit: unknown) => {
  if (typeof workspaceId !== 'string' || !commit || typeof commit !== 'object') throw new TypeError('Invalid commit data.')
  const id = (commit as { id?: unknown }).id
  if (typeof id !== 'string') throw new TypeError('Commit id is required.')
  const safeCommit = { ...(commit as Record<string, unknown>), variables: stripSecretVariableValues((commit as { variables?: WorkspaceVariables }).variables) }
  database().prepare('INSERT OR REPLACE INTO commits (id, workspace_id, data) VALUES (?, ?, ?)').run(id, workspaceId, JSON.stringify(safeCommit))
})

ipcMain.handle('commit:list', (_event, workspaceId: string) => {
  return (database().prepare('SELECT data FROM commits WHERE workspace_id = ? ORDER BY rowid').all(workspaceId) as { data: string }[]).map((row) => {
    const commit = JSON.parse(row.data) as Record<string, unknown>
    return { ...commit, variables: stripSecretVariableValues(commit.variables as WorkspaceVariables | undefined) }
  })
})

ipcMain.handle('secret:available', () => safeStorage.isEncryptionAvailable())

ipcMain.handle('auth:begin', async (_event, cloudUrl: string) => {
  let base: URL
  try { base = new URL(cloudUrl) } catch { throw new TypeError('Invalid cloud URL.') }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new TypeError('Cloud URL must be http or https.')
  activeSignIn?.close()
  activeSignIn = await startLoopbackSignIn((code) => {
    activeSignIn = undefined
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:code', code)
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  const target = new URL('/desktop-login', base)
  target.searchParams.set('desktopLoginState', activeSignIn.state)
  target.searchParams.set('redirect', activeSignIn.redirectUri)
  await shell.openExternal(target.toString())
})

ipcMain.handle('session:load', () => {
  if (!safeStorage.isEncryptionAvailable()) return null
  const row = database().prepare('SELECT value FROM secrets WHERE key = ?').get('api-session') as { value: Uint8Array } | undefined
  return row ? safeStorage.decryptString(Buffer.from(row.value)) : null
})

ipcMain.handle('session:save', (_event, token: string) => {
  if (!safeStorage.isEncryptionAvailable()) return false
  const encrypted = safeStorage.encryptString(token)
  database().prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('api-session', encrypted)
  return true
})

ipcMain.handle('session:clear', () => {
  database().prepare('DELETE FROM secrets WHERE key = ?').run('api-session')
})

let latestUpdateStatus: UpdateStatus | undefined
const updateCheckIntervalMs = 10 * 60 * 1000
let checkForUpdatesNow: (() => void) | undefined
const minUpdateCheckGapMs = 60 * 1000

// Auto-update runs only in packaged builds. The feed comes from the publish
// config in package.json; API_DOCS_UPDATE_URL overrides it for local testing.
function setupAutoUpdate(): void {
  if (!app.isPackaged) return
  if (process.env.API_DOCS_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.API_DOCS_UPDATE_URL })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  const sendUpdateStatus = (status: UpdateStatus) => {
    latestUpdateStatus = status
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status)
  }
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (progress) => {
    const version = latestUpdateStatus && 'version' in latestUpdateStatus ? latestUpdateStatus.version : ''
    sendUpdateStatus({ state: 'downloading', version, percent: Math.floor(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (error) => console.error('Auto-update check failed:', error))
  // Skip while an update is already found or downloading, and never check twice within a minute
  // (window focus and the timer can fire close together).
  let lastCheckAt = 0
  checkForUpdatesNow = () => {
    if (latestUpdateStatus?.state === 'downloaded' || latestUpdateStatus?.state === 'downloading') return
    if (Date.now() - lastCheckAt < minUpdateCheckGapMs) return
    lastCheckAt = Date.now()
    void autoUpdater.checkForUpdates().catch((error) => console.error('Auto-update check failed:', error))
  }
  checkForUpdatesNow()
  setInterval(() => checkForUpdatesNow?.(), updateCheckIntervalMs).unref()
}

ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())
ipcMain.handle('update:latest', () => latestUpdateStatus ?? null)

app.whenReady().then(() => {
  watchExternalWorkspaceChanges()
  setupAutoUpdate()
  if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient('api-docs', process.execPath, [process.argv[1]])
  else app.setAsDefaultProtocolClient('api-docs')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (databaseWatchTimer) clearInterval(databaseWatchTimer)
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveInviteLink(url)
})

app.on('second-instance', (_event, commandLine) => {
  const link = commandLine.find((argument) => argument.startsWith('api-docs://'))
  if (link) receiveInviteLink(link)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

const launchInviteLink = process.argv.find((argument) => argument.startsWith('api-docs://'))
if (launchInviteLink) receiveInviteLink(launchInviteLink)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
