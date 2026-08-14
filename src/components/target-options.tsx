'use client'

import { useState } from 'react'
import PlatformIcon from './platform-icon'
import type { Capabilities, Issue } from '@/platforms/types'

/**
 * Per-destination panel: tailored copy plus whatever extra fields the platform
 * demands (subreddit, YouTube title, TikTok privacy). Collapsed unless the
 * platform requires something or validation has a complaint.
 */
export default function TargetOptions({
  account, platform, overrideText, baseText, options, issues,
  onOverrideText, onClearOverride, onOptions,
}: {
  account: { id: string; platform: string; handle: string | null; displayName: string | null; meta: Record<string, unknown> }
  platform: { id: string; label: string; color: string; capabilities: Capabilities }
  overrideText: string | undefined
  baseText: string
  options: Record<string, unknown>
  issues: Issue[]
  onOverrideText: (v: string) => void
  onClearOverride: () => void
  onOptions: (v: Record<string, unknown>) => void
}) {
  const fields = platform.capabilities.options ?? []
  const errors = issues.filter((i) => i.level === 'error')
  const warnings = issues.filter((i) => i.level === 'warning')
  const mustExpand = errors.length > 0 || fields.some((f) => f.required && !options[f.key])
  const [open, setOpen] = useState(mustExpand)
  const expanded = open || mustExpand

  // Pinterest caches the user's boards at connect time, so offer a real picker.
  const boards = account.meta?.boards as { id: string; name: string }[] | undefined

  return (
    <div className={`card p-4 space-y-3 ${errors.length ? 'border-danger' : ''}`}>
      <button className="flex items-center gap-2.5 w-full text-left" onClick={() => setOpen(!expanded)}>
        <PlatformIcon platform={platform.id} color={platform.color} size={24} />
        <span className="text-sm font-medium flex-1">{platform.label} · {account.handle ?? account.displayName}</span>
        {errors.length > 0 && <span className="text-xs text-danger">{errors.length} issue{errors.length > 1 ? 's' : ''}</span>}
        {!errors.length && warnings.length > 0 && <span className="text-xs text-warn">{warnings.length} note{warnings.length > 1 ? 's' : ''}</span>}
        <span className="text-xs text-muted">{expanded ? '−' : '+'}</span>
      </button>

      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="text-xs space-y-1">
          {errors.map((i, n) => <li key={`e${n}`} className="text-danger">{i.message}</li>)}
          {warnings.map((i, n) => <li key={`w${n}`} className="text-warn">{i.message}</li>)}
        </ul>
      )}

      {expanded && (
        <div className="space-y-3 border-t border-line pt-3">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="label mb-0">Text for {platform.label}</label>
              {overrideText !== undefined && (
                <button className="text-xs text-muted hover:text-ink" onClick={onClearOverride}>use shared text</button>
              )}
            </div>
            <textarea
              className="input min-h-20 resize-y"
              value={overrideText ?? baseText}
              onChange={(e) => onOverrideText(e.target.value)}
              placeholder={baseText || 'Tailor the copy for this platform'}
            />
            <p className="text-xs text-muted mt-1">
              {(overrideText ?? baseText).length}/{platform.capabilities.maxTextLength}
              {overrideText === undefined && ' · editing here creates a per-platform version'}
            </p>
          </div>

          {fields.map((f) => (
            <div key={f.key}>
              <label className="label">{f.label}{f.required && ' *'}</label>

              {f.key === 'boardId' && boards?.length ? (
                <select
                  className="input"
                  value={String(options[f.key] ?? '')}
                  onChange={(e) => onOptions({ ...options, [f.key]: e.target.value })}
                >
                  <option value="">Pick a board...</option>
                  {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              ) : f.type === 'select' ? (
                <select
                  className="input"
                  value={String(options[f.key] ?? f.default ?? '')}
                  onChange={(e) => onOptions({ ...options, [f.key]: e.target.value })}
                >
                  {f.choices?.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              ) : f.type === 'boolean' ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(options[f.key] ?? f.default)}
                    onChange={(e) => onOptions({ ...options, [f.key]: e.target.checked })}
                  />
                  {f.help ?? f.label}
                </label>
              ) : (
                <input
                  className="input"
                  value={String(options[f.key] ?? f.default ?? '')}
                  onChange={(e) => onOptions({ ...options, [f.key]: e.target.value })}
                />
              )}

              {f.help && f.type !== 'boolean' && <p className="text-xs text-muted mt-1 leading-relaxed">{f.help}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
