'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useWorkspace } from '@/components/workspace-context'
import { apiFetch } from '@/lib/client'
import PlatformIcon from '@/components/platform-icon'
import CredentialsDialog from '@/components/credentials-dialog'

interface PlatformInfo {
  id: string
  label: string
  color: string
  connect: { kind: string; docsUrl: string; fields: any[] }
  caveats: string[]
  setup: { tier: 'instant' | 'app' | 'review'; note: string }
  configured: boolean
}

interface Account {
  id: string
  platform: string
  handle: string | null
  displayName: string | null
  avatarUrl: string | null
  status: 'active' | 'needs_reauth' | 'disabled'
  lastError: string | null
}

const TIER_STYLE = {
  instant: { label: 'Works now', cls: 'text-accent border-accent' },
  app: { label: 'Needs a dev app', cls: 'text-warn border-warn' },
  review: { label: 'Needs platform review', cls: 'text-danger border-danger' },
} as const

export default function AccountsPage() {
  const { active } = useWorkspace()
  const params = useSearchParams()
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [dialog, setDialog] = useState<PlatformInfo | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function reload() {
    const [p, a] = await Promise.all([
      apiFetch<PlatformInfo[]>('/api/platforms'),
      apiFetch<Account[]>(`/api/accounts?workspace=${active.id}`),
    ])
    setPlatforms(p)
    setAccounts(a)
  }

  useEffect(() => {
    reload().catch((e) => setNotice({ kind: 'err', text: e.message }))
  }, [active.id])

  useEffect(() => {
    const err = params.get('error')
    const connected = params.get('connected')
    if (err) setNotice({ kind: 'err', text: err })
    else if (connected) setNotice({ kind: 'ok', text: `Connected ${params.get('count') ?? 1} ${connected} destination(s).` })
  }, [params])

  function connect(p: PlatformInfo) {
    if (p.connect.kind === 'oauth2') {
      window.location.href = `/api/oauth/${p.id}/start?workspace=${active.id}&redirectTo=/accounts`
    } else {
      setDialog(p)
    }
  }

  async function disconnect(a: Account) {
    if (!confirm(`Disconnect ${a.handle ?? a.displayName}? Scheduled posts to this account will fail.`)) return
    await apiFetch(`/api/accounts/${a.id}`, { method: 'DELETE' })
    reload()
  }

  const byPlatform = (id: string) => accounts.filter((a) => a.platform === id)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Connected accounts</h1>
        <p className="text-sm text-muted mt-1">
          Every destination you can publish to. The badge tells you what it takes to get each one live.
        </p>
      </div>

      {notice && (
        <div className={`card p-3 text-sm ${notice.kind === 'err' ? 'text-danger' : 'text-accent'}`}>
          {notice.text}
          <button className="float-right text-muted hover:text-ink" onClick={() => setNotice(null)}>x</button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {platforms.map((p) => {
          const connected = byPlatform(p.id)
          const tier = TIER_STYLE[p.setup.tier]
          return (
            <div key={p.id} className="card p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <PlatformIcon platform={p.id} color={p.color} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium leading-tight">{p.label}</div>
                  <span className={`inline-block mt-1 text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${tier.cls}`}>
                    {tier.label}
                  </span>
                </div>
              </div>

              <p className="text-xs text-muted leading-relaxed">{p.setup.note}</p>

              {connected.length > 0 && (
                <ul className="space-y-1.5 border-t border-line pt-3">
                  {connected.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-sm">
                      {a.avatarUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={a.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover" />
                        : <span className="w-5 h-5 rounded-full bg-line" />}
                      <span className="truncate flex-1">{a.handle ?? a.displayName}</span>
                      {a.status === 'needs_reauth' && (
                        <span className="text-[10px] text-danger border border-danger rounded px-1" title={a.lastError ?? ''}>
                          reconnect
                        </span>
                      )}
                      <button className="text-xs text-muted hover:text-danger" onClick={() => disconnect(a)}>remove</button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-auto pt-1 flex items-center gap-2">
                <button
                  className="btn btn-primary text-xs py-1.5"
                  disabled={!p.configured}
                  title={p.configured ? '' : 'Set this platform\'s client credentials in .env first'}
                  onClick={() => connect(p)}
                >
                  {connected.length ? 'Add another' : 'Connect'}
                </button>
                <a href={p.connect.docsUrl} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-ink">
                  setup docs
                </a>
              </div>

              {!p.configured && (
                <p className="text-xs text-warn">Missing client credentials in .env.</p>
              )}

              {p.caveats.length > 0 && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer hover:text-ink">Gotchas ({p.caveats.length})</summary>
                  <ul className="mt-2 space-y-1.5 list-disc pl-4 leading-relaxed">
                    {p.caveats.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )
        })}
      </div>

      {dialog && (
        <CredentialsDialog
          platform={dialog}
          workspaceId={active.id}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload() }}
        />
      )}
    </div>
  )
}
