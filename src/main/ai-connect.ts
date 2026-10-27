import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { readNodeRuntime, type NodeRuntimePaths } from './node-runtime'

// Connects the local API Documentation MCP server to AI clients. The MCP server is
// started by the client with the app's own Node runtime, so it works without the
// user's shell PATH.

export const mcpServerName = 'api-documentation'
const mcpPackage = 'api-documentation-mcp@latest'

export type AiToolId = 'codex' | 'claude-cli' | 'claude-desktop'

export type AiToolStatus = {
  id: AiToolId
  supported: boolean
  installed: boolean
  connected: boolean
}

export type AiConnectStatus = {
  node: { installed: boolean; version?: string }
  tools: AiToolStatus[]
}

const cliPackages: Record<'codex' | 'claude-cli', { package: string; bin: string }> = {
  codex: { package: '@openai/codex', bin: 'codex' },
  'claude-cli': { package: '@anthropic-ai/claude-code', bin: 'claude' }
}

function toolsDir(userDataDir: string): string {
  return join(userDataDir, 'ai-tools')
}

function appToolBin(userDataDir: string, bin: string): string {
  const name = process.platform === 'win32' ? `${bin}.cmd` : bin
  return join(toolsDir(userDataDir), 'node_modules', '.bin', name)
}

function runtimeEnv(runtime: NodeRuntimePaths): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${runtime.binDir}${delimiter}${process.env.PATH ?? ''}` }
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
}

function claudeCliConfigPath(): string {
  return join(homedir(), '.claude.json')
}

function claudeDesktopConfigPath(): string | null {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
  return null
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function findOnPath(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const child = spawn(finder, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : null))
  })
}

async function resolveCli(userDataDir: string, id: 'codex' | 'claude-cli'): Promise<string | null> {
  const appBin = appToolBin(userDataDir, cliPackages[id].bin)
  if (existsSync(appBin)) return appBin
  return findOnPath(cliPackages[id].bin)
}

export async function getAiConnectStatus(userDataDir: string): Promise<AiConnectStatus> {
  const runtime = await readNodeRuntime(join(userDataDir, 'runtime'))
  const codexConfig = await readFile(codexConfigPath(), 'utf8').catch(() => '')
  const claudeCli = await readJson(claudeCliConfigPath())
  const desktopPath = claudeDesktopConfigPath()
  const desktop = desktopPath ? await readJson(desktopPath) : {}
  const desktopServers = (desktop.mcpServers ?? {}) as Record<string, unknown>
  const cliServers = (claudeCli.mcpServers ?? {}) as Record<string, unknown>

  return {
    node: runtime.installed ? { installed: true, version: runtime.version } : { installed: false },
    tools: [
      {
        id: 'codex',
        supported: true,
        installed: Boolean(await resolveCli(userDataDir, 'codex')),
        connected: codexConfig.includes(`[mcp_servers.${mcpServerName}]`)
      },
      {
        id: 'claude-cli',
        supported: true,
        installed: Boolean(await resolveCli(userDataDir, 'claude-cli')),
        connected: Boolean(cliServers[mcpServerName])
      },
      {
        id: 'claude-desktop',
        supported: desktopPath !== null,
        installed: desktopPath !== null && existsSync(dirname(desktopPath)),
        connected: Boolean(desktopServers[mcpServerName])
      }
    ]
  }
}

export type AiLogLine = (line: string) => void

function runCommand(file: string, args: string[], env: NodeJS.ProcessEnv, onLine: AiLogLine, cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLine(line)
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export async function installCli(
  userDataDir: string,
  runtime: NodeRuntimePaths,
  id: 'codex' | 'claude-cli',
  onLine: AiLogLine
): Promise<void> {
  const dir = toolsDir(userDataDir)
  await mkdir(dir, { recursive: true })
  onLine(`Installing ${cliPackages[id].package} into the app folder…`)
  const code = await runCommand(runtime.npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', cliPackages[id].package], runtimeEnv(runtime), onLine)
  if (code !== 0) throw new Error(`npm install failed for ${cliPackages[id].package} (exit ${code}).`)
  onLine('Install finished.')
}

function mcpCommand(runtime: NodeRuntimePaths): string[] {
  return [runtime.node, runtime.npxCli, '-y', mcpPackage]
}

async function connectWithCli(
  userDataDir: string,
  runtime: NodeRuntimePaths,
  id: 'codex' | 'claude-cli',
  onLine: AiLogLine
): Promise<void> {
  const bin = await resolveCli(userDataDir, id)
  if (!bin) throw new Error(`${cliPackages[id].bin} is not installed yet. Install it first.`)
  const env = runtimeEnv(runtime)
  const scope = id === 'claude-cli' ? ['--scope', 'user'] : []
  const removeArgs = id === 'codex'
    ? ['mcp', 'remove', mcpServerName]
    : ['mcp', 'remove', mcpServerName, '--scope', 'user']
  // Replacing an existing entry keeps the command and args current. Removal failing is fine when none exists.
  await runCommand(bin, removeArgs, env, () => {}).catch(() => 0)
  onLine(`Registering ${mcpServerName} with ${cliPackages[id].bin}…`)
  const addArgs = [...(id === 'codex' ? ['mcp', 'add', mcpServerName] : ['mcp', 'add', ...scope, mcpServerName]), '--', ...mcpCommand(runtime)]
  const code = await runCommand(bin, addArgs, env, onLine)
  if (code !== 0) throw new Error(`${cliPackages[id].bin} mcp add failed (exit ${code}).`)
  onLine(`Connected. Start a new ${cliPackages[id].bin} session to use the tools.`)
}

async function connectClaudeDesktop(runtime: NodeRuntimePaths, onLine: AiLogLine): Promise<void> {
  const path = claudeDesktopConfigPath()
  if (!path) throw new Error('Claude Desktop is not available on this operating system.')
  const config = await readJson(path)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  const [command, ...args] = mcpCommand(runtime)
  servers[mcpServerName] = { command, args }
  config.mcpServers = servers
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
  onLine(`Wrote ${path}`)
  onLine('Restart Claude Desktop to load the API Documentation tools.')
}

export async function connectAiTool(
  userDataDir: string,
  runtime: NodeRuntimePaths,
  id: AiToolId,
  onLine: AiLogLine
): Promise<void> {
  if (id === 'claude-desktop') return connectClaudeDesktop(runtime, onLine)
  return connectWithCli(userDataDir, runtime, id, onLine)
}
