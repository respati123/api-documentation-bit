type Props = {
  email: string
  busy: boolean
  done: boolean
  error: string
  onApprove: () => void
  onCancel: () => void
}

export function DesktopLoginApprove({ email, busy, done, error, onApprove, onCancel }: Props) {
  return <main className="auth-layout">
    <section className="auth-brand-panel">
      <div className="auth-brand">
        <span className="product-mark" aria-hidden="true"><span /><span /><span /></span>
        <span>API Documentation</span>
      </div>
      <div className="auth-brand-copy"><p className="auth-kicker">DESKTOP SIGN-IN</p><h1>Approve this sign-in.</h1><p>The desktop app is waiting for you to confirm it's really you before it connects to your cloud workspace.</p></div>
      <p className="auth-brand-foot">Desktop app and browser portal · one shared cloud workspace</p>
    </section>
    <section className="auth-form-panel">
      <div className="auth-form-wrap">
        <p className="page-eyebrow">API DOCUMENTATION CLOUD</p>
        <h2>Sign in to the desktop app?</h2>
        <p className="auth-subtitle">Signed in as <strong>{email}</strong>. Approving lets the desktop app on this computer access your workspaces.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {done
          ? <div className="auth-invite-note" role="status">Approved. Return to the desktop app — it should sign in automatically. You can close this tab.</div>
          : <div className="auth-form">
            <button type="button" className="cloud-button cloud-button-primary auth-submit" disabled={busy} onClick={onApprove}>{busy ? 'Approving…' : 'Approve sign-in'}</button>
            <button type="button" className="cloud-button cloud-button-secondary" disabled={busy} onClick={onCancel}>Not me — cancel</button>
          </div>}
      </div>
    </section>
  </main>
}
