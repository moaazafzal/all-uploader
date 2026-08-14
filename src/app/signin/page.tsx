'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/client'

export default function SignInPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [form, setForm] = useState({ email: '', password: '', name: '', workspaceName: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await apiFetch(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(form) })
      router.push('/accounts')
      router.refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">All Uploader</h1>
        <p className="text-sm text-muted mt-1 mb-6">One composer, every connected account.</p>

        <form onSubmit={submit} className="card p-5 space-y-4">
          {mode === 'signup' && (
            <>
              <div>
                <label className="label">Your name</label>
                <input className="input" value={form.name} onChange={set('name')} required />
              </div>
              <div>
                <label className="label">Workspace name</label>
                <input className="input" value={form.workspaceName} onChange={set('workspaceName')} placeholder="Acme Social" />
              </div>
            </>
          )}
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={form.email} onChange={set('email')} required />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" value={form.password} onChange={set('password')} required minLength={mode === 'signup' ? 10 : 1} />
            {mode === 'signup' && <p className="text-xs text-muted mt-1">At least 10 characters.</p>}
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <button className="btn btn-primary w-full justify-center" disabled={busy}>
            {busy ? 'Working...' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>

          <button
            type="button"
            className="text-xs text-muted hover:text-ink w-full text-center"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError('') }}
          >
            {mode === 'signin' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    </main>
  )
}
