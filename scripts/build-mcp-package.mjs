// Bundles the MCP server into a single executable file for the npm package.
import { build } from 'esbuild'
import { chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const packageDir = join(root, '..', 'packages', 'api-documentation-mcp')

await build({
  entryPoints: [join(root, '..', 'src', 'mcp', 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(packageDir, 'dist', 'index.js'),
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning'
})
await chmod(join(packageDir, 'dist', 'index.js'), 0o755)
console.log('built packages/api-documentation-mcp/dist/index.js')
