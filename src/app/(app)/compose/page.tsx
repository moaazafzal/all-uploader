'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWorkspace } from '@/components/workspace-context'
import { apiFetch, fmtBytes } from '@/lib/client'
import PlatformIcon from '@/components/platform-icon'
import MediaPicker, { type Media } from '@/components/media-picker'
import TargetOptions from '@/components/target-options'
import { checkCapabilities } from '@/platforms/validate'
import type { Capabilities, Issue } from '@/platforms/types'

interface PlatformInfo { id: string; label: string; color: string; capabilities: Capabilities }
interface Account { id: string; platform: string; handle: string | null; displayName: string | null; avatarUrl: string | null; status: string; meta: Record<string, any> }

export default function ComposePage() {
  const { active } = useWorkspace()
  const router = useRouter()

  const [platforms, setPlatforms] = useState<PlatformInfo[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [text, setText] = useState('')
  const [media, setMedia] = useState<Media[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [options, setOptions] = useState<Record<string, Record<string, unknown>>>({})
  const [scheduledAt, setScheduledAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      apiFetch<PlatformInfo[]>('/api/platforms'),
      apiFetch<Account[]>(`/api/accounts?workspace=${active.id}`),
    ])
      .then(([p, a]) => { setPlatforms(p); setAccounts(a) })
      .catch((e) => setError(e.message))
  }, [active.id])

  const platformOf = (id: string) => platforms.find((p) => p.id === id)

  /**
   * Validation runs in the browser against the same capability rules the server
   * enforces, so limits appear as you type rather than after a failed publish.
   */
  const checks = useMemo(() => {
    return selected.map((accountId) => {
      const account = accounts.find((a) => a.id === accountId)!
      const platform = platformOf(account.platform)
      if (!platform) return { accountId, account, issues: [] as Issue[] }
      const issues = checkCapabilities(platform.capabilities, {
        text: overrides[accountId] ?? text,
        media: media.map((m) => ({
          id: m.id, kind: m.kind, filename: m.filename, mimeType: m.mimeType, bytes: m.bytes,
          width: m.width, height: m.height, durationMs: m.durationMs, path: '', publicUrl: null,
        })),
        options: options[accountId] ?? {},
      })
      if (account.status === 'needs_reauth') {
        issues.push({ level: 'error', field: 'account', message: 'This account needs to be reconnected.' })
      }
      return { accountId, account, issues }
    })
  }, [selected, accounts, platforms, text, overrides, media, options])

  const blocking = checks.filter((c) => c.issues.some((i) => i.level === 'error'))
  const canPublish = selected.length > 0 && blocking.length === 0 && !busy

  function toggle(accountId: string) {
    setSelected((s) => (s.includes(accountId) ? s.filter((x) => x !== accountId) : [...s, accountId]))
  }

  async function submit(publishNow: boolean) {
    setBusy(true)
    setError('')
    try {
      const post = await apiFetch<{ id: string }>('/api/posts', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: active.id,
          text,
          mediaIds: media.map((m) => m.id),
          scheduledAt: scheduledAt || null,
          targets: selected.map((id) => ({
            accountId: id,
            overrideText: overrides[id] ?? null,
            options: options[id] ?? {},
          })),
        }),
      })
      await apiFetch(`/api/posts/${post.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({ scheduledAt: publishNow ? null : scheduledAt || null }),
      })
      router.push('/posts')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!accounts.length) {
    return (
      <div className="card p-8 text-center">
        <p className="font-medium">No accounts connected yet.</p>
        <p className="text-sm text-muted mt-1 mb-4">Connect at least one destination before composing.</p>
        <a href="/accounts" className="btn btn-primary">Connect an account</a>
      </div>
    )
  }

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
      <div className="space-y-4">
        <div className="card p-4">
          <label className="label">Post text</label>
          <textarea
            className="input min-h-40 resize-y font-[inherit]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write once. It goes everywhere you pick."
          />
          <CounterRow text={text} selected={selected} accounts={accounts} platforms={platforms} overrides={overrides} />
        </div>

        <MediaPicker workspaceId={active.id} media={media} onChange={setMedia} />

        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Publish to</h2>
            <button
              className="text-xs text-muted hover:text-ink"
              onClick={() => setSelected(selected.length === accounts.length ? [] : accounts.map((a) => a.id))}
            >
              {selected.length === accounts.length ? 'Clear all' : 'Select all'}
            </button>
          </div>

          <div className="grid sm:grid-cols-2 gap-2">
            {accounts.map((a) => {
              const on = selected.includes(a.id)
              const p = platformOf(a.platform)
              const check = checks.find((c) => c.accountId === a.id)
              const hasError = check?.issues.some((i) => i.level === 'error')
              return (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  className={`flex items-center gap-2.5 p-2.5 rounded-md border text-left transition-colors ${
                    on ? (hasError ? 'border-danger' : 'border-accent') : 'border-line hover:border-muted'
                  }`}
                >
                  <PlatformIcon platform={a.platform} color={p?.color ?? '#888'} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm truncate">{a.handle ?? a.displayName}</span>
                    <span className="block text-xs text-muted">{p?.label ?? a.platform}</span>
                  </span>
                  <span className={`w-4 h-4 rounded border grid place-items-center text-[10px] ${on ? 'bg-accent border-accent text-white' : 'border-line'}`}>
                    {on ? '✓' : ''}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {selected.map((id) => {
          const account = accounts.find((a) => a.id === id)!
          const platform = platformOf(account.platform)
          if (!platform) return null
          return (
            <TargetOptions
              key={id}
              account={account}
              platform={platform}
              overrideText={overrides[id]}
              baseText={text}
              options={options[id] ?? {}}
              issues={checks.find((c) => c.accountId === id)?.issues ?? []}
              onOverrideText={(v) => setOverrides({ ...overrides, [id]: v })}
              onClearOverride={() => {
                const next = { ...overrides }
                delete next[id]
                setOverrides(next)
              }}
              onOptions={(v) => setOptions({ ...options, [id]: v })}
            />
          )
        })}
      </div>

      <aside className="card p-4 space-y-4 lg:sticky lg:top-20">
        <div>
          <label className="label">Schedule for</label>
          <input
            className="input"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <p className="text-xs text-muted mt-1">Leave empty to publish immediately.</p>
        </div>

        <div className="border-t border-line pt-3 text-sm space-y-1">
          <Row label="Destinations" value={String(selected.length)} />
          <Row label="Attachments" value={media.length ? `${media.length} (${fmtBytes(media.reduce((n, m) => n + m.bytes, 0))})` : 'none'} />
          <Row label="Blocking issues" value={String(blocking.length)} danger={blocking.length > 0} />
        </div>

        {blocking.length > 0 && (
          <ul className="text-xs text-danger space-y-1 border-t border-line pt-3">
            {blocking.map((b) => (
              <li key={b.accountId}>
                <strong>{b.account.handle ?? b.account.displayName}</strong>:{' '}
                {b.issues.filter((i) => i.level === 'error')[0].message}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-sm text-danger border-t border-line pt-3">{error}</p>}

        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <button className="btn btn-primary justify-center" disabled={!canPublish} onClick={() => submit(!scheduledAt)}>
            {busy ? 'Working...' : scheduledAt ? 'Schedule post' : 'Publish now'}
          </button>
          <p className="text-xs text-muted leading-relaxed">
            Each destination publishes independently. If one fails the others still go out, and you can retry just the failure.
          </p>
        </div>
      </aside>
    </div>
  )
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className={danger ? 'text-danger font-medium' : ''}>{value}</span>
    </div>
  )
}

/** Per-platform character budget, tightest limit first. */
function CounterRow({ text, selected, accounts, platforms, overrides }: {
  text: string
  selected: string[]
  accounts: Account[]
  platforms: PlatformInfo[]
  overrides: Record<string, string>
}) {
  const rows = selected
    .map((id) => {
      const account = accounts.find((a) => a.id === id)
      const platform = platforms.find((p) => p.id === account?.platform)
      if (!account || !platform) return null
      const body = overrides[id] ?? text
      return { id, label: platform.label, used: body.length, max: platform.capabilities.maxTextLength }
    })
    .filter(Boolean) as { id: string; label: string; used: number; max: number }[]

  if (!rows.length) return <p className="text-xs text-muted mt-2">{text.length} characters</p>

  rows.sort((a, b) => a.max - a.used - (b.max - b.used))
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs">
      {rows.map((r) => (
        <span key={r.id} className={r.used > r.max ? 'text-danger font-medium' : 'text-muted'}>
          {r.label} {r.used}/{r.max}
        </span>
      ))}
    </div>
  )
}
