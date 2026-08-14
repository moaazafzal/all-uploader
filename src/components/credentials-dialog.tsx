'use client'

import { useState } from 'react'
import { apiFetch } from '@/lib/client'

interface Field { key: string; label: string; type: string; required: boolean; help?: string; default?: string | boolean }

export default function CredentialsDialog({
  platform, workspaceId, onClose, onSaved,
}: {
  platform: { id: string; label: string; connect: { fields: Field[]; docsUrl: string } }
  workspaceId: string
  onClose: () => void
  onSaved: () => void
}) {
  const fields = platform.connect.fields
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, String(f.default ?? '')])),
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      // The server verifies against the real platform before storing anything.
      await apiFetch('/api/accounts/connect', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, platform: platform.id, fields: values }),
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center p-4 z-50" onClick={onClose}>
      <form className="card p-5 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div>
          <h2 className="font-semibold">Connect {platform.label}</h2>
          <a href={platform.connect.docsUrl} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-ink">
            Where do I find these?
          </a>
        </div>

        {fields.map((f) => (
          <div key={f.key}>
            <label className="label">{f.label}{f.required && ' *'}</label>
            <input
              className="input"
              value={values[f.key] ?? ''}
              required={f.required}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
            {f.help && <p className="text-xs text-muted mt-1 leading-relaxed">{f.help}</p>}
          </div>
        ))}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Verifying...' : 'Connect'}</button>
        </div>
      </form>
    </div>
  )
}
