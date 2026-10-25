// The desktop app sends its loopback callback address (http://127.0.0.1:<port>/callback).
// Only that shape is accepted, so a crafted link cannot send a sign-in code to another host.
export function isDesktopLoopbackRedirect(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    && url.port !== ''
    && url.pathname === '/callback'
    && url.search === ''
    && url.hash === ''
}
