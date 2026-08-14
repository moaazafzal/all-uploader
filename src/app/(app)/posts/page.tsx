'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWorkspace } from '@/components/workspace-context'
import { apiFetch, fmtDate } from '@/lib/client'
import PlatformIcon from '@/components/platform-icon'

interface Target {
  id: string
  platform: string
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
  remoteUrl: string | null
  error: string | null
  attempts: number
  accountHandle: string | null
}

interface Post {
  id: string
  text: string
  status: string
  scheduledAt: string | null
  publishedAt: string | null
  createdAt: string
  targets: Target[]
  media: { id: string; kind: string; filename: string }[]
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'text-muted border-line',
  scheduled: 'text-warn border-warn',
  publishing: 'text-warn border-warn',
  published: 'text-accent border-accent',
  partial: 'text-warn border-warn',
  failed: 'text-danger border-danger',
  cancelled: 'text-muted border-line',
}

export default function PostsPage() {
  const { active } = useWorkspace()
  const [posts, setPosts] = useState<Post[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setPosts(await apiFetch<Post[]>(`/api/posts?workspace=${active.id}`))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [active.id])

  useEffect(() => {
    // While anything is mid-flight the queue is changing rows underneath us.
    let cancelled = false
    const tick = () => { if (!cancelled) load() }
    tick()
    const t = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [load])

  async function retry(id: string) {
    try {
      await apiFetch(`/api/posts/${id}/retry`, { method: 'POST' })
      void fetch(`/api/posts/${id}/kick`, { method: 'POST' }).catch(() => {})
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (loading) return <p className="text-sm text-muted">Loading...</p>

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Posts</h1>
        <a href="/compose" className="btn btn-primary text-sm">New post</a>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {!posts.length && <div className="card p-8 text-center text-sm text-muted">Nothing posted yet.</div>}

      {posts.map((p) => {
        const failed = p.targets.filter((t) => t.status === 'failed')
        return (
          <div key={p.id} className="card p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm whitespace-pre-wrap line-clamp-3">{p.text || <span className="text-muted italic">no text</span>}</p>
                <p className="text-xs text-muted mt-1.5">
                  {p.publishedAt ? `Published ${fmtDate(p.publishedAt)}` : p.scheduledAt ? `Scheduled for ${fmtDate(p.scheduledAt)}` : `Created ${fmtDate(p.createdAt)}`}
                  {p.media.length > 0 && ` · ${p.media.length} attachment${p.media.length > 1 ? 's' : ''}`}
                </p>
              </div>
              <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 shrink-0 ${STATUS_STYLE[p.status] ?? ''}`}>
                {p.status}
              </span>
            </div>

            <ul className="space-y-1.5 border-t border-line pt-3">
              {p.targets.map((t) => (
                <li key={t.id} className="flex items-start gap-2 text-sm">
                  <PlatformIcon platform={t.platform} color="#888" size={20} />
                  <span className="text-muted shrink-0">{t.accountHandle}</span>
                  <span className="flex-1 min-w-0">
                    {t.status === 'published' && t.remoteUrl && (
                      <a href={t.remoteUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">view post</a>
                    )}
                    {t.status === 'published' && !t.remoteUrl && <span className="text-accent">published</span>}
                    {(t.status === 'pending' || t.status === 'publishing') && (
                      <span className="text-warn">{t.status}{t.attempts > 1 ? ` (attempt ${t.attempts})` : ''}</span>
                    )}
                    {t.status === 'failed' && <span className="text-danger break-words">{t.error}</span>}
                    {t.status === 'skipped' && <span className="text-muted">skipped</span>}
                  </span>
                </li>
              ))}
            </ul>

            {failed.length > 0 && (
              <div className="border-t border-line pt-3">
                <button className="btn text-xs py-1.5" onClick={() => retry(p.id)}>
                  Retry {failed.length} failed destination{failed.length > 1 ? 's' : ''}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
