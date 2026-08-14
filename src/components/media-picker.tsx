'use client'

import { useRef, useState } from 'react'
import { apiFetch, fmtBytes } from '@/lib/client'

export interface Media {
  id: string
  kind: 'image' | 'video'
  filename: string
  mimeType: string
  bytes: number
  width: number | null
  height: number | null
  durationMs: number | null
}

export default function MediaPicker({
  workspaceId, media, onChange,
}: {
  workspaceId: string
  media: Media[]
  onChange: (m: Media[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)

  async function upload(files: FileList | File[]) {
    if (!files.length) return
    setBusy(true)
    setError('')
    try {
      const fd = new FormData()
      fd.set('workspaceId', workspaceId)
      for (const f of Array.from(files)) fd.append('files', f)
      const saved = await apiFetch<Media[]>('/api/media', { method: 'POST', body: fd })
      onChange([...media, ...saved])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= media.length) return
    const next = [...media]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange(next)
  }

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Media</h2>
        {media.length > 1 && <span className="text-xs text-muted">Order matters for carousels</span>}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files) }}
        onClick={() => input.current?.click()}
        className={`border border-dashed rounded-md p-6 text-center cursor-pointer transition-colors ${
          dragging ? 'border-accent bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]' : 'border-line hover:border-muted'
        }`}
      >
        <p className="text-sm">{busy ? 'Uploading...' : 'Drop images or video here, or click to browse'}</p>
        <p className="text-xs text-muted mt-1">Uploaded once, reused for every destination.</p>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {media.length > 0 && (
        <ul className="space-y-2">
          {media.map((m, i) => (
            <li key={m.id} className="flex items-center gap-3 p-2 rounded-md border border-line">
              {m.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/media/${m.id}/raw`} alt="" className="w-12 h-12 rounded object-cover bg-line" />
              ) : (
                <span className="w-12 h-12 rounded bg-line grid place-items-center text-xs text-muted">video</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{m.filename}</p>
                <p className="text-xs text-muted">
                  {fmtBytes(m.bytes)}
                  {m.width && m.height ? ` · ${m.width}×${m.height}` : ''}
                  {m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}s` : ''}
                  {m.kind === 'video' && !m.durationMs ? ' · duration unknown (install ffmpeg to probe)' : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 text-xs text-muted">
                <button className="px-1 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
                <button className="px-1 hover:text-ink disabled:opacity-30" disabled={i === media.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                <button className="px-1 hover:text-danger" onClick={() => onChange(media.filter((x) => x.id !== m.id))}>remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
