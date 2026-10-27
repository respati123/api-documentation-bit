import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Status = Awaited<ReturnType<typeof window.apiDesktop.aiStatus>>
type ToolId = 'codex' | 'claude-cli' | 'claude-desktop'

const toolLabels: Record<ToolId, string> = {
  codex: 'Codex',
  'claude-cli': 'Claude CLI',
  'claude-desktop': 'Claude Desktop'
}

const logLimit = 200

export function AiConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [nodeProgress, setNodeProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const logRef = useRef<HTMLPreElement>(null)

  const refresh = useCallback(async () => {
    setStatus(await window.apiDesktop.aiStatus())
  }, [])

  useEffect(() => {
    if (!open) return
    setError('')
    void refresh()
    const offLog = window.apiDesktop.onAiLog((line) => setLog((current) => [...current.slice(-(logLimit - 1)), line]))
    const offNode = window.apiDesktop.onNodeProgress((progress) => {
      setNodeProgress(progress.stage === 'downloading' ? progress.percent ?? 0 : null)
    })
    return () => { offLog(); offNode() }
  }, [open, refresh])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Something went wrong.')
    } finally {
      setBusy(null)
      setNodeProgress(null)
      await refresh()
    }
  }

  const nodeReady = Boolean(status?.node.installed)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect AI assistant</DialogTitle>
          <DialogDescription>Let Codex, Claude Desktop, or Claude CLI read and edit your local API collections through the API Documentation MCP server.</DialogDescription>
        </DialogHeader>

        <div className="ai-connect-list">
          <div className="ai-connect-row">
            <div>
              <strong>Node.js</strong>
              <span>{nodeReady ? `Already installed: ${status?.node.version} (${status?.node.source === 'system' ? 'this computer' : 'app folder'})` : 'Needed to run the MCP server. Installed into the app folder, no admin rights needed.'}</span>
            </div>
            {!nodeReady && (
              <Button size="sm" disabled={Boolean(busy)} onClick={() => void run('node', () => window.apiDesktop.installNodeRuntime())}>
                {busy === 'node' ? (nodeProgress !== null ? `Downloading ${nodeProgress}%` : 'Installing…') : 'Install Node.js'}
              </Button>
            )}
          </div>

          {(['codex', 'claude-cli', 'claude-desktop'] as ToolId[]).map((id) => {
            const tool = status?.tools.find((item) => item.id === id)
            const supported = tool?.supported ?? true
            const installed = tool?.installed ?? false
            const connected = tool?.connected ?? false
            const needsInstall = id !== 'claude-desktop' && !installed
            return (
              <div className="ai-connect-row" key={id}>
                <div>
                  <strong>{toolLabels[id]}</strong>
                  <span>
                    {!supported ? 'Not available on this operating system.'
                      : connected ? 'Connected'
                      : installed || id === 'claude-desktop' ? 'Not connected yet'
                      : 'Not installed'}
                  </span>
                </div>
                <div className="ai-connect-actions">
                  {supported && needsInstall && (
                    <Button size="sm" variant="outline" disabled={Boolean(busy) || !nodeReady} onClick={() => void run(id, () => window.apiDesktop.installAiTool(id as 'codex' | 'claude-cli'))}>
                      {busy === id ? 'Installing…' : 'Install'}
                    </Button>
                  )}
                  {supported && !needsInstall && (
                    <Button size="sm" disabled={Boolean(busy) || !nodeReady} onClick={() => void run(id, () => window.apiDesktop.connectAiTool(id))}>
                      {busy === id ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <p className="ai-connect-note">Connecting replaces any existing "api-documentation" entry in that tool's settings. Restart Claude Desktop after connecting.</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        {log.length > 0 && <pre className="ai-connect-log" ref={logRef} aria-label="Setup log">{log.join('\n')}</pre>}
      </DialogContent>
    </Dialog>
  )
}
