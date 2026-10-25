import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { SQL } from 'bun'
import nodemailer from 'nodemailer'

type Role = 'owner' | 'editor' | 'viewer'
type BodyMode = 'form-data' | 'urlencoded' | 'graphql' | 'json' | 'xml' | 'yaml' | 'edn' | 'text' | 'other' | 'file' | 'none'
type BodyField = { id: string; name: string; value: string; enabled: boolean; type: 'text' | 'file'; filePath?: string; fileName?: string }
type HeaderField = { id: string; name: string; value: string; enabled: boolean; description?: string }
type ParamField = { id: string; name: string; value: string; enabled: boolean; description?: string }
type RequestAuth = { type: 'none' } | { type: 'bearer'; token: string } | { type: 'basic'; username: string; password: string } | { type: 'api-key'; name: string; value: string; location: 'header' | 'query' }
type WorkspaceVariable = { id: string; name: string; value: string; secret: boolean }
type WorkspaceEnvironment = { id: string; name: string; variables: WorkspaceVariable[] }
type WorkspaceVariables = { globals: WorkspaceVariable[]; environments: WorkspaceEnvironment[] }
type TreeNode =
  | { id: string; kind: 'folder'; name: string; children: TreeNode[] }
  | { id: string; kind: 'request'; name: string; method: string; url: string; body: string; bodyMode?: BodyMode; bodyFields?: BodyField[]; bodyVariables?: string; bodyMimeType?: string; bodyPath?: string; bodyFileName?: string; headers?: HeaderField[]; params?: ParamField[]; auth?: RequestAuth; documentation?: string; deprecated?: boolean; deprecationReason?: string }
type AuthUser = { id: string; email: string }
type SyncSocketData = { userId: string }
type SyncSocketTicket = { userId: string; expiresAt: number }

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required. Copy server/.env.example to server/.env and set it.')
const db = new SQL(databaseUrl)
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000
const syncSocketTickets = new Map<string, SyncSocketTicket>()
const syncSockets = new Set<Bun.ServerWebSocket<SyncSocketData>>()
const desktopLoginCodes = new Map<string, { userId: string; expiresAt: number }>()

class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message) }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' } })
}

function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex') }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}
async function sendInviteEmail(to: string, workspaceName: string, role: 'editor' | 'viewer', inviterEmail: string, inviteUrl: string): Promise<void> {
  const host = process.env.SMTP_HOST?.trim()
  if (!host) throw new Error('SMTP_HOST is not configured.')
  const port = Number(process.env.SMTP_PORT || 1025)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT is invalid.')
  const user = process.env.SMTP_USER?.trim()
  const password = process.env.SMTP_PASSWORD
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE?.toLowerCase() === 'true',
    ...(user && password ? { auth: { user, pass: password } } : {})
  })
  const safeWorkspaceName = escapeHtml(workspaceName)
  const safeRole = escapeHtml(role)
  const safeInviterEmail = escapeHtml(inviterEmail)
  const safeInviteUrl = escapeHtml(inviteUrl)
  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'API Documentation <no-reply@example.test>',
    to,
    subject: `Invitation to ${workspaceName}`,
    text: `${inviterEmail} invited you to join ${workspaceName} with the ${role} role.\n\nThis invitation expires in 7 days. Open the API Documentation desktop app and use this invitation link:\n${inviteUrl}`,
    html: `<p><strong>${safeInviterEmail}</strong> invited you to join <strong>${safeWorkspaceName}</strong> with the <strong>${safeRole}</strong> role.</p><p>This invitation expires in 7 days.</p><p><a href="${safeInviteUrl}">Open invitation in API Documentation</a></p><p>If the link does not open the app, copy this link into the app's invitation field:<br><code>${safeInviteUrl}</code></p>`
  })
}
function isAllowedSyncOrigin(origin: string | null): boolean {
  if (!origin || origin === 'null' || origin === 'file://') return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch { return false }
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value ?? fallback) as T
  try { return JSON.parse(value) as T } catch { return fallback }
}

function emptyWorkspaceVariables(): WorkspaceVariables { return { globals: [], environments: [] } }

function sanitizeWorkspaceVariables(value: WorkspaceVariables): WorkspaceVariables {
  const cleanRows = (rows: WorkspaceVariable[]) => rows.map(({ id, name, value: variableValue, secret }) => ({ id, name, value: variableValue, secret }))
  return {
    globals: cleanRows(value.globals),
    environments: value.environments.map(({ id, name, variables }) => ({ id, name, variables: cleanRows(variables) }))
  }
}

function validateWorkspaceVariables(value: unknown): value is WorkspaceVariables {
  if (!isRecord(value) || !Array.isArray(value.globals) || !Array.isArray(value.environments) || value.globals.length > 500 || value.environments.length > 100) return false
  const ids = new Set<string>()
  let count = 0
  function validVariable(item: unknown): item is WorkspaceVariable {
    if (!isRecord(item) || ++count > 2000 || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || item.name.length > 160 || typeof item.value !== 'string' || item.value.length > 65536 || typeof item.secret !== 'boolean') return false
    if (item.secret && item.value !== '') return false
    ids.add(item.id)
    return true
  }
  if (!value.globals.every(validVariable)) return false
  return value.environments.every((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || !Array.isArray(item.variables) || item.variables.length > 500) return false
    ids.add(item.id)
    return item.variables.every(validVariable)
  })
}

function parseSnapshot(value: unknown): { tree: TreeNode[]; variables: WorkspaceVariables } {
  if (Array.isArray(value)) return { tree: value as TreeNode[], variables: emptyWorkspaceVariables() }
  if (!isRecord(value) || !validateTree(value.tree)) return { tree: [], variables: emptyWorkspaceVariables() }
  const variables = value.variables === undefined ? emptyWorkspaceVariables() : value.variables
  return validateWorkspaceVariables(variables) ? { tree: value.tree, variables: sanitizeWorkspaceVariables(variables) } : { tree: value.tree, variables: emptyWorkspaceVariables() }
}

function validateTree(value: unknown): value is TreeNode[] {
  if (!Array.isArray(value) || value.length > 1000) return false
  let count = 0
  const ids = new Set<string>()
  function valid(node: unknown, depth: number): node is TreeNode {
    if (!isRecord(node) || depth > 30 || ++count > 10000 || typeof node.id !== 'string' || ids.has(node.id) || typeof node.name !== 'string' || node.name.trim().length > 160) return false
    ids.add(node.id)
    if (node.kind === 'folder') return Array.isArray(node.children) && node.children.length <= 1000 && node.children.every((child) => valid(child, depth + 1))
    if (node.kind !== 'request' || typeof node.method !== 'string' || typeof node.url !== 'string' || typeof node.body !== 'string') return false
    if (node.documentation !== undefined && (typeof node.documentation !== 'string' || node.documentation.length > 100000)) return false
    if (node.deprecated !== undefined && typeof node.deprecated !== 'boolean') return false
    if (node.deprecationReason !== undefined && (typeof node.deprecationReason !== 'string' || node.deprecationReason.length > 4096)) return false
    if (node.bodyMode !== undefined && !['form-data', 'urlencoded', 'graphql', 'json', 'xml', 'yaml', 'edn', 'text', 'other', 'file', 'none'].includes(String(node.bodyMode))) return false
    if (node.bodyPath !== undefined) return false
    if (node.headers !== undefined && (!Array.isArray(node.headers) || node.headers.length > 100 || !node.headers.every((header) => {
      if (!isRecord(header)) return false
      return typeof header.id === 'string' && typeof header.name === 'string' && header.name.length <= 8192 && typeof header.value === 'string' && header.value.length <= 65536 && typeof header.enabled === 'boolean' && (header.description === undefined || typeof header.description === 'string' && header.description.length <= 4096)
    }))) return false
    if (node.params !== undefined && (!Array.isArray(node.params) || node.params.length > 100 || !node.params.every((param) => {
      if (!isRecord(param)) return false
      return typeof param.id === 'string' && typeof param.name === 'string' && typeof param.value === 'string' && typeof param.enabled === 'boolean' && (param.description === undefined || typeof param.description === 'string' && param.description.length <= 4096)
    }))) return false
    if (node.auth !== undefined) {
      if (!isRecord(node.auth)) return false
      const auth = node.auth
      const validAuth = auth.type === 'none'
        || auth.type === 'bearer' && typeof auth.token === 'string'
        || auth.type === 'basic' && typeof auth.username === 'string' && typeof auth.password === 'string'
        || auth.type === 'api-key' && typeof auth.name === 'string' && typeof auth.value === 'string' && (auth.location === 'header' || auth.location === 'query')
      if (!validAuth) return false
    }
    if (node.bodyFields !== undefined && (!Array.isArray(node.bodyFields) || node.bodyFields.length > 100 || !node.bodyFields.every((field) => {
      if (!isRecord(field)) return false
      return typeof field.id === 'string' && typeof field.name === 'string' && typeof field.value === 'string' && typeof field.enabled === 'boolean' && (field.type === 'text' || field.type === 'file') && field.filePath === undefined && (field.fileName === undefined || typeof field.fileName === 'string')
    }))) return false
    return ['bodyVariables', 'bodyMimeType', 'bodyPath', 'bodyFileName'].every((key) => node[key] === undefined || typeof node[key] === 'string')
  }
  return value.every((node) => valid(node, 0))
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (!isRecord(body)) throw new Error()
    return body
  } catch { throw new HttpError(400, 'Request body must be a JSON object.') }
}

async function currentUser(request: Request): Promise<AuthUser> {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!bearer) throw new HttpError(401, 'Sign in is required.')
  const [user] = await db`SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${tokenHash(bearer)} AND s.expires_at > now()`
  if (!user) throw new HttpError(401, 'Session expired. Sign in again.')
  return user as AuthUser
}

async function requireRole(workspaceId: string, userId: string, allowed: Role[]): Promise<Role> {
  const [membership] = await db`SELECT role FROM memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`
  if (!membership) throw new HttpError(404, 'Workspace not found.')
  const role = membership.role as Role
  if (!allowed.includes(role)) throw new HttpError(403, 'Your workspace role cannot perform this action.')
  return role
}

async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${tokenHash(token)}, ${userId}, ${new Date(Date.now() + sessionLifetimeMs)})`
  return token
}

async function createWorkspace(user: AuthUser, name: string, snapshot: TreeNode[], variables: WorkspaceVariables) {
  if (!name.trim() || name.trim().length > 100) throw new HttpError(400, 'Workspace name must be 1–100 characters.')
  if (!validateTree(snapshot) || !validateWorkspaceVariables(variables)) throw new HttpError(400, 'Workspace snapshot is invalid.')
  variables = sanitizeWorkspaceVariables(variables)
  const workspaceId = randomUUID()
  const commitId = randomUUID()
  await db.begin(async (tx) => {
    await tx`INSERT INTO workspaces (id, name, owner_id, head_commit_id) VALUES (${workspaceId}, ${name.trim()}, ${user.id}, ${commitId})`
    await tx`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${user.id}, 'owner')`
    await tx`INSERT INTO commits (id, workspace_id, author_id, parent_ids, message, snapshot) VALUES (${commitId}, ${workspaceId}, ${user.id}, '[]'::jsonb, 'Workspace created', ${JSON.stringify({ tree: snapshot, variables })}::jsonb)`
  })
  return { id: workspaceId, name: name.trim(), role: 'owner' as Role, headCommitId: commitId, tree: snapshot, variables }
}

async function handle(request: Request, server: Bun.Server<SyncSocketData>): Promise<Response | undefined> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = request.method.toUpperCase()
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' } })
  if (method === 'GET' && path === '/health') return json({ ok: true })

  if (method === 'GET' && path === '/api/sync/events') {
    if (!isAllowedSyncOrigin(request.headers.get('origin'))) return json({ error: 'WebSocket origin is not allowed.' }, 403)
    const ticket = url.searchParams.get('ticket')
    const ticketKey = ticket ? tokenHash(ticket) : ''
    const ticketData = ticketKey ? syncSocketTickets.get(ticketKey) : undefined
    if (!ticketData || ticketData.expiresAt <= Date.now()) {
      if (ticketKey) syncSocketTickets.delete(ticketKey)
      return json({ error: 'WebSocket ticket is missing or expired.' }, 401)
    }
    syncSocketTickets.delete(ticketKey)
    return server.upgrade(request, { data: { userId: ticketData.userId } })
      ? undefined
      : json({ error: 'Could not open the sync notification connection.' }, 400)
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const body = await bodyOf(request)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.')
    if (password.length < 10 || password.length > 256) throw new HttpError(400, 'Password must be 10–256 characters.')
    const id = randomUUID()
    try {
      const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
      await db`INSERT INTO users (id, email, password_hash) VALUES (${id}, ${email}, ${hash})`
    } catch (error) {
      if (isRecord(error) && error.code === '23505') throw new HttpError(409, 'An account with this email already exists.')
      throw error
    }
    const token = await createSession(id)
    return json({ token, user: { id, email } }, 201)
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const body = await bodyOf(request)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const [user] = await db`SELECT id, email, password_hash FROM users WHERE email = ${email}`
    if (!user || !await Bun.password.verify(password, user.password_hash)) throw new HttpError(401, 'Email or password is incorrect.')
    const token = await createSession(user.id)
    return json({ token, user: { id: user.id, email: user.email } })
  }

  if (method === 'GET' && path === '/api/me') return json({ user: await currentUser(request) })

  if (method === 'POST' && path === '/api/desktop-login/exchange') {
    const body = await bodyOf(request)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code) throw new HttpError(400, 'A sign-in code is required.')
    const key = tokenHash(code)
    const entry = desktopLoginCodes.get(key)
    desktopLoginCodes.delete(key)
    if (!entry || entry.expiresAt <= Date.now()) throw new HttpError(400, 'This sign-in link expired or was already used. Sign in again from the desktop app.')
    const [matchedUser] = await db`SELECT id, email FROM users WHERE id = ${entry.userId}`
    if (!matchedUser) throw new HttpError(404, 'Account not found.')
    const token = await createSession(entry.userId)
    return json({ token, user: { id: matchedUser.id, email: matchedUser.email } })
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (bearer) await db`DELETE FROM sessions WHERE token_hash = ${tokenHash(bearer)}`
    return json({ ok: true })
  }

  const user = await currentUser(request)
  if (method === 'POST' && path === '/api/sync/events-ticket') {
    const now = Date.now()
    for (const [key, value] of syncSocketTickets) if (value.expiresAt <= now) syncSocketTickets.delete(key)
    const ticket = randomBytes(32).toString('base64url')
    syncSocketTickets.set(tokenHash(ticket), { userId: user.id, expiresAt: now + 30_000 })
    return json({ ticket, expiresInSeconds: 30 })
  }

  if (method === 'POST' && path === '/api/desktop-login/approve') {
    const now = Date.now()
    for (const [key, value] of desktopLoginCodes) if (value.expiresAt <= now) desktopLoginCodes.delete(key)
    const code = randomBytes(32).toString('base64url')
    desktopLoginCodes.set(tokenHash(code), { userId: user.id, expiresAt: now + 2 * 60_000 })
    return json({ code, expiresInSeconds: 120 })
  }

  if (method === 'GET' && path === '/api/workspaces') {
    const rows = await db`SELECT w.id, w.name, m.role, w.head_commit_id AS "headCommitId", w.created_at AS "createdAt", c.created_at AS "updatedAt" FROM workspaces w JOIN memberships m ON m.workspace_id = w.id LEFT JOIN commits c ON c.id = w.head_commit_id WHERE m.user_id = ${user.id} ORDER BY c.created_at DESC NULLS LAST, w.created_at DESC`
    return json({ workspaces: rows })
  }

  if (method === 'POST' && path === '/api/workspaces') {
    const body = await bodyOf(request)
    const tree = body.tree === undefined ? [] : body.tree
    const variables = body.variables === undefined ? emptyWorkspaceVariables() : body.variables
    if (!validateTree(tree)) throw new HttpError(400, 'Workspace tree is invalid or contains local-only file paths.')
    if (!validateWorkspaceVariables(variables)) throw new HttpError(400, 'Workspace variables are invalid or include a secret value.')
    return json({ workspace: await createWorkspace(user, String(body.name || ''), tree, variables) }, 201)
  }

  if (method === 'POST' && path === '/api/invites/accept') {
    const body = await bodyOf(request)
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!token) throw new HttpError(400, 'Invite token is required.')
    const result = await db.begin(async (tx) => {
      const [invite] = await tx`SELECT id, workspace_id, email, role FROM invites WHERE token_hash = ${tokenHash(token)} AND used_at IS NULL AND expires_at > now() FOR UPDATE`
      if (!invite) return null
      if (invite.email && String(invite.email).toLowerCase() !== user.email.toLowerCase()) throw new HttpError(403, `This invitation was sent to ${invite.email}. Sign in with that email address.`)
      await tx`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${invite.workspace_id}, ${user.id}, ${invite.role}) ON CONFLICT (workspace_id, user_id) DO NOTHING`
      await tx`UPDATE invites SET used_at = now() WHERE id = ${invite.id}`
      const [workspace] = await tx`SELECT id, name, head_commit_id AS "headCommitId" FROM workspaces WHERE id = ${invite.workspace_id}`
      const [commit] = await tx`SELECT snapshot FROM commits WHERE id = ${workspace.headCommitId}`
      const snapshot = parseSnapshot(parseJson<unknown>(commit.snapshot, []))
      return { ...workspace, role: invite.role, ...snapshot }
    })
    if (!result) throw new HttpError(410, 'Invite link is invalid, expired, or already used.')
    return json({ workspace: result })
  }

  const workspaceMatch = path.match(/^\/api\/workspaces\/([\w-]+)(?:\/(.*))?$/)
  if (!workspaceMatch) throw new HttpError(404, 'Endpoint not found.')
  const workspaceId = workspaceMatch[1]
  const action = workspaceMatch[2] || ''

  if (method === 'GET' && action === 'members') {
    await requireRole(workspaceId, user.id, ['owner', 'editor', 'viewer'])
    const members = await db`SELECT u.id, u.email, m.role, m.created_at AS "joinedAt" FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ${workspaceId} ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.created_at`
    return json({ members })
  }

  if (method === 'GET' && action === 'invites') {
    await requireRole(workspaceId, user.id, ['owner'])
    const invites = await db`SELECT i.id, i.email, i.role, i.expires_at AS "expiresAt", i.created_at AS "createdAt", u.email AS "createdByEmail" FROM invites i JOIN users u ON u.id = i.created_by WHERE i.workspace_id = ${workspaceId} AND i.used_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`
    return json({ invites })
  }

  if (method === 'POST' && action === 'invites') {
    await requireRole(workspaceId, user.id, ['owner'])
    const body = await bodyOf(request)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid invitation email address.')
    const role = body.role === 'viewer' ? 'viewer' : body.role === 'editor' ? 'editor' : null
    if (!role) throw new HttpError(400, 'Invite role must be editor or viewer.')
    const [workspace] = await db`SELECT name FROM workspaces WHERE id = ${workspaceId}`
    if (!workspace) throw new HttpError(404, 'Workspace not found.')
    const [existingMember] = await db`SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ${workspaceId} AND lower(u.email) = ${email}`
    if (existingMember) throw new HttpError(409, 'This account is already a workspace member.')
    await db`DELETE FROM invites WHERE workspace_id = ${workspaceId} AND lower(email) = ${email} AND used_at IS NULL`
    const rawToken = randomBytes(32).toString('base64url')
    const id = randomUUID()
    await db`INSERT INTO invites (id, workspace_id, email, token_hash, role, expires_at, created_by) VALUES (${id}, ${workspaceId}, ${email}, ${tokenHash(rawToken)}, ${role}, ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)}, ${user.id})`
    const publicWebUrl = process.env.PUBLIC_WEB_URL?.trim().replace(/\/+$/, '')
    const inviteUrl = publicWebUrl
      ? `${publicWebUrl}/invite?token=${encodeURIComponent(rawToken)}`
      : `api-docs://invite?token=${encodeURIComponent(rawToken)}`
    let emailSent = false
    if (process.env.SMTP_HOST?.trim()) {
      try { await sendInviteEmail(email, String(workspace.name), role, user.email, inviteUrl); emailSent = true }
      catch (error) { console.error('Workspace invitation email delivery failed:', error) }
    }
    return json({ id, token: rawToken, email, expiresInDays: 7, role, emailSent }, 201)
  }

  const inviteMatch = action.match(/^invites\/([\w-]+)$/)
  if (method === 'DELETE' && inviteMatch) {
    await requireRole(workspaceId, user.id, ['owner'])
    await db`DELETE FROM invites WHERE id = ${inviteMatch[1]} AND workspace_id = ${workspaceId}`
    return json({ ok: true })
  }

  if (method === 'GET' && action === 'sync/pull') {
    await requireRole(workspaceId, user.id, ['owner', 'editor', 'viewer'])
    const [workspace] = await db`SELECT w.id, w.name, m.role, w.head_commit_id AS "headCommitId", c.parent_ids AS "parentIds", c.message, c.snapshot, c.created_at AS "createdAt" FROM workspaces w JOIN memberships m ON m.workspace_id = w.id LEFT JOIN commits c ON c.id = w.head_commit_id WHERE w.id = ${workspaceId} AND m.user_id = ${user.id}`
    if (!workspace) return json({ workspace: null })
    const snapshot = parseSnapshot(parseJson<unknown>(workspace.snapshot, []))
    const { snapshot: _snapshot, ...workspaceData } = workspace
    return json({ workspace: { ...workspaceData, parentIds: parseJson<string[]>(workspace.parentIds, []), ...snapshot } })
  }

  if (method === 'GET' && action === 'sync/history') {
    await requireRole(workspaceId, user.id, ['owner', 'editor', 'viewer'])
    const rows = await db`SELECT c.id, c.parent_ids AS "parentIds", c.message, c.created_at AS "createdAt", u.email AS "authorEmail" FROM commits c JOIN users u ON u.id = c.author_id WHERE c.workspace_id = ${workspaceId} ORDER BY c.created_at DESC LIMIT 500`
    const commits = rows.map((row: { id: unknown; parentIds: unknown; message: unknown; createdAt: string | Date; authorEmail: unknown }) => ({
      id: String(row.id),
      parentIds: parseJson<string[]>(row.parentIds, []),
      message: String(row.message),
      createdAt: row.createdAt,
      authorEmail: String(row.authorEmail)
    }))
    return json({ commits })
  }

  const historyCommitMatch = action.match(/^sync\/history\/([\w-]+)$/)
  if (method === 'GET' && historyCommitMatch) {
    await requireRole(workspaceId, user.id, ['owner', 'editor', 'viewer'])
    const [row] = await db`SELECT id, parent_ids AS "parentIds", message, snapshot, created_at AS "createdAt" FROM commits WHERE workspace_id = ${workspaceId} AND id = ${historyCommitMatch[1]}`
    if (!row) throw new HttpError(404, 'Commit not found.')
    return json({ commit: {
      id: String(row.id),
      parentIds: parseJson<string[]>(row.parentIds, []),
      message: String(row.message),
      createdAt: row.createdAt,
      ...parseSnapshot(parseJson<unknown>(row.snapshot, []))
    } })
  }

  if (method === 'POST' && action === 'sync/push') {
    await requireRole(workspaceId, user.id, ['owner', 'editor'])
    const body = await bodyOf(request)
    if (!Array.isArray(body.commits) || body.commits.length === 0 || body.commits.length > 100) throw new HttpError(400, 'Provide 1–100 commits to push.')
    const commits = body.commits as Record<string, unknown>[]
    for (const commit of commits) {
      const variables = commit.variables === undefined ? emptyWorkspaceVariables() : commit.variables
      if (typeof commit.id !== 'string' || !Array.isArray(commit.parentIds) || typeof commit.message !== 'string' || !validateTree(commit.tree) || !validateWorkspaceVariables(variables)) throw new HttpError(400, 'A commit in the push is invalid or includes a secret value.')
    }
    const result = await db.begin(async (tx) => {
      const [workspace] = await tx`SELECT head_commit_id AS "headCommitId" FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`
      if (!workspace) throw new HttpError(404, 'Workspace not found.')
      let headId = workspace.headCommitId as string | null
      for (const commit of commits) {
        const parents = commit.parentIds as string[]
        if (headId && !parents.includes(headId)) {
          const [remote] = await tx`SELECT id, parent_ids AS "parentIds", message, snapshot, created_at AS "createdAt" FROM commits WHERE id = ${headId}`
          const snapshot = remote ? parseSnapshot(parseJson<unknown>(remote.snapshot, [])) : null
          const { snapshot: _snapshot, ...remoteData } = remote ?? {}
          return { conflict: remote && snapshot ? { ...remoteData, parentIds: parseJson<string[]>(remote.parentIds, []), ...snapshot } : null }
        }
        if (!headId && parents.length > 0) return { conflict: null }
        const variables = sanitizeWorkspaceVariables(commit.variables === undefined ? emptyWorkspaceVariables() : commit.variables as WorkspaceVariables)
        await tx`INSERT INTO commits (id, workspace_id, author_id, parent_ids, message, snapshot) VALUES (${commit.id}, ${workspaceId}, ${user.id}, ${JSON.stringify(parents)}::jsonb, ${commit.message}, ${JSON.stringify({ tree: commit.tree, variables })}::jsonb) ON CONFLICT (id) DO NOTHING`
        headId = commit.id as string
        await tx`UPDATE workspaces SET head_commit_id = ${headId} WHERE id = ${workspaceId}`
      }
      return { headId }
    })
    if ('conflict' in result) return json({ error: 'remote_advanced', remote: result.conflict }, 409)
    if (result.headId) {
      const members = await db`SELECT user_id AS "userId" FROM memberships WHERE workspace_id = ${workspaceId}`
      const memberIds = new Set(members.map((member: { userId: unknown }) => String(member.userId)))
      const lastCommit = commits[commits.length - 1]
      const event = JSON.stringify({
        type: 'workspace.updated',
        workspaceId,
        headCommitId: result.headId,
        message: typeof lastCommit.message === 'string' ? lastCommit.message : 'Workspace updated',
        actorId: user.id,
        actorEmail: user.email,
        commitCount: commits.length
      })
      for (const socket of syncSockets) {
        if (!memberIds.has(socket.data.userId)) continue
        try { socket.send(event) }
        catch { syncSockets.delete(socket) }
      }
    }
    return json({ headCommitId: result.headId })
  }

  throw new HttpError(404, 'Endpoint not found.')
}

async function initialize() {
  const schema = await Bun.file(new URL('./schema.sql', import.meta.url)).text()
  for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) await db.unsafe(statement)
  const port = Number(process.env.PORT || 3001)
  Bun.serve({
    port,
    websocket: {
      data: {} as SyncSocketData,
      open(socket) { syncSockets.add(socket) },
      message(socket) { socket.close(1008, 'Client messages are not supported.') },
      close(socket) { syncSockets.delete(socket) }
    },
    async fetch(request, server) {
      try { return await handle(request, server) }
      catch (error) {
        if (error instanceof HttpError) return json({ error: error.message, details: error.details }, error.status)
        if (isRecord(error) && error.code === '23505') return json({ error: 'This membership already exists.' }, 409)
        console.error(error)
        return json({ error: 'Internal server error.' }, 500)
      }
    }
  })
  console.log(`API server listening on http://localhost:${port}`)
}

await initialize()
