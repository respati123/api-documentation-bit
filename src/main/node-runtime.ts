import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

// Downloads an official Node.js LTS build into the app's own folder, so the app
// can run npx and AI client CLIs without sudo or a system-wide install.

const nodeDistUrl = 'https://nodejs.org/dist'
const majorVersion = 22
export const minimumNodeMajor = majorVersion

export type NodeRuntimePaths = {
  root: string
  binDir: string
  node: string
  npm: string
  npxCli: string
}

export type NodeRuntimeStatus =
  | { installed: false }
  | ({ installed: true; version: string; source: 'app' | 'system' } & NodeRuntimePaths)

// Absolute paths inside the downloaded Node folder. Absolute paths matter because
// GUI apps (Claude Desktop, Codex launched from a dock) do not inherit the shell PATH.
export function nodeRuntimePaths(root: string): NodeRuntimePaths {
  if (process.platform === 'win32') {
    return {
      root,
      binDir: root,
      node: join(root, 'node.exe'),
      npm: join(root, 'npm.cmd'),
      npxCli: join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    }
  }
  return {
    root,
    binDir: join(root, 'bin'),
    node: join(root, 'bin', 'node'),
    npm: join(root, 'bin', 'npm'),
    npxCli: join(root, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  }
}

export type NodeInstallProgress = { stage: 'checking' | 'downloading' | 'verifying' | 'extracting' | 'done'; percent?: number }

type NodeIndexEntry = { version: string; lts: string | false }

function platformKey(): { os: string; arch: string; archive: string } {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return { os: 'win', arch, archive: 'zip' }
  if (process.platform === 'darwin') return { os: 'darwin', arch, archive: 'tar.gz' }
  if (process.platform === 'linux') return { os: 'linux', arch, archive: 'tar.xz' }
  throw new Error(`Unsupported platform: ${process.platform}`)
}

async function latestLtsVersion(): Promise<string> {
  const response = await fetch(`${nodeDistUrl}/index.json`)
  if (!response.ok) throw new Error(`Could not read the Node.js release list (${response.status}).`)
  const entries = (await response.json()) as NodeIndexEntry[]
  const match = entries.find((entry) => entry.lts && entry.version.startsWith(`v${majorVersion}.`))
  if (!match) throw new Error(`No Node.js ${majorVersion} LTS release was found.`)
  return match.version
}

async function expectedChecksum(version: string, fileName: string): Promise<string> {
  const response = await fetch(`${nodeDistUrl}/${version}/SHASUMS256.txt`)
  if (!response.ok) throw new Error(`Could not read the Node.js checksums (${response.status}).`)
  const line = (await response.text()).split('\n').find((row) => row.trim().endsWith(` ${fileName}`))
  if (!line) throw new Error(`No checksum found for ${fileName}.`)
  return line.trim().split(/\s+/)[0]
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())))
  })
}

// Returns the absolute path of a command found on PATH, or null.
export function findOnPath(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const child = spawn(finder, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : null))
  })
}

function majorOf(version: string): number {
  return Number(version.replace(/^v/, '').split('.')[0])
}

// A Node.js that is already on this computer and new enough. Its npx-cli.js is
// located next to it, in the standard layout of the official installers.
async function readSystemNode(): Promise<NodeRuntimeStatus> {
  const found = await findOnPath(process.platform === 'win32' ? 'node.exe' : 'node')
  if (!found) return { installed: false }
  const version = await run(found, ['--version']).catch(() => '')
  if (!version || majorOf(version) < minimumNodeMajor) return { installed: false }
  // PATH may point to a version manager shim (mise, nvm, volta). Ask Node where its real binary is.
  const nodePath = await run(found, ['-p', 'process.execPath']).catch(() => '')
  if (!nodePath) return { installed: false }
  const binDir = dirname(nodePath)
  const npxCandidates = process.platform === 'win32'
    ? [join(binDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')]
    : [join(dirname(binDir), 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')]
  const npxCli = npxCandidates.find((candidate) => existsSync(candidate))
  if (!npxCli) return { installed: false }
  const root = process.platform === 'win32' ? binDir : dirname(binDir)
  return { installed: true, version, source: 'system', root, binDir, node: nodePath, npm: join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm'), npxCli }
}

// Prefers the Node.js downloaded into the app folder, then a Node.js already on this
// computer that meets the minimum version. Downloading is only needed when neither exists.
export async function readNodeRuntime(baseDir: string): Promise<NodeRuntimeStatus> {
  const appRuntime = await readAppNodeRuntime(baseDir)
  if (appRuntime.installed) return appRuntime
  return readSystemNode()
}

async function readAppNodeRuntime(baseDir: string): Promise<NodeRuntimeStatus> {
  const marker = join(baseDir, 'current.json')
  let info: { version: string; dir: string }
  try {
    info = JSON.parse(await readFile(marker, 'utf8'))
  } catch {
    return { installed: false }
  }
  const paths = nodeRuntimePaths(info.dir)
  try {
    const version = await run(paths.node, ['--version'])
    if (version !== info.version) return { installed: false }
    return { installed: true, version, source: 'app', ...paths }
  } catch {
    return { installed: false }
  }
}

export async function installNodeRuntime(
  baseDir: string,
  onProgress: (progress: NodeInstallProgress) => void = () => {}
): Promise<NodeRuntimeStatus> {
  onProgress({ stage: 'checking' })
  const version = await latestLtsVersion()
  const { os, arch, archive } = platformKey()
  const folderName = `node-${version}-${os}-${arch}`
  const fileName = `${folderName}.${archive}`

  await mkdir(baseDir, { recursive: true })
  const archivePath = join(baseDir, fileName)
  const partialPath = `${archivePath}.partial`

  onProgress({ stage: 'downloading', percent: 0 })
  const response = await fetch(`${nodeDistUrl}/${version}/${fileName}`)
  if (!response.ok || !response.body) throw new Error(`Could not download Node.js (${response.status}).`)
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  let lastPercent = -1
  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      received += chunk.byteLength
      if (total > 0) {
        const percent = Math.floor((received / total) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress({ stage: 'downloading', percent })
        }
      }
      yield chunk
    }
  }
  await pipeline(Readable.from(counter(response.body as unknown as AsyncIterable<Uint8Array>)), createWriteStream(partialPath))
  await rename(partialPath, archivePath)

  onProgress({ stage: 'verifying' })
  const expected = await expectedChecksum(version, fileName)
  const actual = await sha256Of(archivePath)
  if (actual !== expected) {
    await rm(archivePath, { force: true })
    throw new Error('The downloaded Node.js file did not match its checksum. It was removed.')
  }

  onProgress({ stage: 'extracting' })
  const extractDir = join(baseDir, folderName)
  await rm(extractDir, { recursive: true, force: true })
  await run('tar', ['-xf', archivePath, '-C', baseDir])
  await rm(archivePath, { force: true })
  await rm(join(baseDir, 'current.json'), { force: true })
  // Keep the marker last so a half-extracted runtime is never reported as installed.
  await writeFile(join(baseDir, 'current.json'), JSON.stringify({ version, dir: extractDir }))

  const status = await readAppNodeRuntime(baseDir)
  onProgress({ stage: 'done' })
  return status
}
