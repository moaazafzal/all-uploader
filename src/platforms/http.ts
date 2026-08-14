import { PublishError } from './types'

/** 4xx that means the token is dead, not that the request was malformed. */
const REAUTH_STATUSES = new Set([401])
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

export interface ApiOptions extends RequestInit {
  /** Prefix for error messages, e.g. "X media upload". */
  label: string
  /** Parse the response as JSON (default) or return raw text. */
  parse?: 'json' | 'text' | 'none'
  timeoutMs?: number
}

export async function api<T = unknown>(url: string, opts: ApiOptions): Promise<T> {
  const { label, parse = 'json', timeoutMs = 120_000, ...init } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(url, { ...init, signal: init.signal ?? controller.signal })
  } catch (err) {
    clearTimeout(timer)
    // Network-level failure: worth another attempt.
    throw new PublishError(`${label}: ${(err as Error).message}`, { retryable: true })
  }
  clearTimeout(timer)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PublishError(`${label}: HTTP ${res.status} ${truncate(body)}`, {
      status: res.status,
      retryable: RETRYABLE_STATUSES.has(res.status),
      reauth: REAUTH_STATUSES.has(res.status),
    })
  }

  if (parse === 'none') return undefined as T
  if (parse === 'text') return (await res.text()) as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new PublishError(`${label}: response was not JSON -- ${truncate(text)}`)
  }
}

const truncate = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}...` : s)

export const bearer = (token: string | null) => {
  if (!token) throw new PublishError('No access token stored for this account.', { reauth: true })
  return { Authorization: `Bearer ${token}` }
}

export const form = (obj: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, String(v))
  return p
}

/** Poll until `check` reports done. Used by Instagram / TikTok / Pinterest async publish. */
export async function poll<T>(
  fn: () => Promise<T>,
  check: (v: T) => 'done' | 'wait' | { error: string },
  opts: { attempts?: number; intervalMs?: number; label: string },
): Promise<T> {
  const { attempts = 30, intervalMs = 4000, label } = opts
  for (let i = 0; i < attempts; i++) {
    const value = await fn()
    const verdict = check(value)
    if (verdict === 'done') return value
    if (typeof verdict === 'object') throw new PublishError(`${label}: ${verdict.error}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new PublishError(`${label}: still processing after ${(attempts * intervalMs) / 1000}s`, { retryable: true })
}
