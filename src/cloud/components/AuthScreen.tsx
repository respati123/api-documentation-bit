import { FormEvent, useState } from 'react'

type Props = {
  mode: 'login' | 'register'
  setMode: (mode: 'login' | 'register') => void
  busy: boolean
  error: string
  inviteMessage: string
  onSubmit: (event: FormEvent<HTMLFormElement>, email: string, password: string) => void
}

export function AuthScreen({ mode, setMode, busy, error, inviteMessage, onSubmit }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const register = mode === 'register'
  return <main className="auth-layout">
    <section className="auth-brand-panel">
      <div className="auth-brand">
        <span className="product-mark" aria-hidden="true"><span /><span /><span /></span>
        <span>API Documentation</span>
      </div>
      <div className="auth-brand-copy"><p className="auth-kicker">CLOUD WORKSPACE</p><h1>Shared API work, with a clear history.</h1><p>Browse endpoint contracts, follow workspace changes, and keep your team on the same reference.</p></div>
      <div className="auth-model" aria-label="Workspace structure">
        <div><span className="model-glyph model-workspace" />Workspace</div>
        <div className="model-level-one"><span className="model-glyph model-folder" />Collection</div>
        <div className="model-level-two"><span className="model-method">GET</span>Request</div>
        <div className="model-level-three"><span className="model-contract-mark" />Response contract</div>
      </div>
      <p className="auth-brand-foot">Desktop app and browser portal · one shared cloud workspace</p>
    </section>
    <section className="auth-form-panel">
      <div className="auth-form-wrap">
        <p className="page-eyebrow">API DOCUMENTATION CLOUD</p>
        <h2>{register ? 'Create your account' : 'Sign in to your workspace'}</h2>
        <p className="auth-subtitle">{register ? 'Use your team email to create an account.' : 'Continue to your shared collections and API references.'}</p>
        {inviteMessage && <div className="auth-invite-note" role="status">{inviteMessage}</div>}
        <form className="auth-form" onSubmit={(event) => onSubmit(event, email, password)}>
          <label className="cloud-field"><span>Email address</span><input autoComplete="email" autoFocus type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>
          <label className="cloud-field"><span>Password</span><input autoComplete={register ? 'new-password' : 'current-password'} type="password" required minLength={register ? 10 : 1} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={register ? 'At least 10 characters' : 'Enter your password'} /></label>
          {register && <p className="field-hint">Use at least 10 characters.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="cloud-button cloud-button-primary auth-submit" disabled={busy}>{busy ? (register ? 'Creating account…' : 'Signing in…') : (register ? 'Create account' : 'Sign in')}</button>
        </form>
        <p className="auth-switch">{register ? 'Already have an account?' : 'New to API Documentation?'} <button type="button" onClick={() => { setMode(register ? 'login' : 'register'); setPassword('') }}>{register ? 'Sign in' : 'Create account'}</button></p>
        <p className="auth-local-note">For local development, invitations sent by the cloud API appear in Mailpit.</p>
      </div>
    </section>
  </main>
}
