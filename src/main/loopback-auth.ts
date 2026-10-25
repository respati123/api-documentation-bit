import { randomBytes } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:http'

// Loopback redirect for browser sign-in (RFC 8252). The desktop app listens on
// a random 127.0.0.1 port, the browser is sent back there with a one-time code,
// and the code is accepted only when the state matches this sign-in attempt.
// It does not depend on an OS-registered custom URL scheme.

export type LoopbackSignIn = {
  state: string
  redirectUri: string
  close: () => void
}

const callbackPath = '/callback'
const signInTimeoutMs = 5 * 60_000

const signedInPage = '<!doctype html><meta charset="utf-8"><title>Signed in</title><p>Signed in. You can return to the desktop app and close this tab.</p>'
const failedPage = '<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>This sign-in link is invalid or expired. Start sign-in again from the desktop app.</p>'

export function startLoopbackSignIn(onCode: (code: string) => void): Promise<LoopbackSignIn> {
  const state = randomBytes(32).toString('base64url')
  let finished = false
  let timer: NodeJS.Timeout | undefined

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    if (finished || !code || url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(failedPage)
      return
    }
    finished = true
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(signedInPage, () => close())
    onCode(code)
  })

  function close(): void {
    if (timer) clearTimeout(timer)
    server.close()
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      timer = setTimeout(close, signInTimeoutMs)
      resolve({ state, redirectUri: `http://127.0.0.1:${port}${callbackPath}`, close })
    })
  })
}
