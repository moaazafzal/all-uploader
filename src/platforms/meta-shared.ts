import { api, form } from './http'
import { PublishError, type DecryptedAccount, type ResolvedMedia, type TokenSet } from './types'

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0'
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`
export const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VERSION}`

/**
 * Instagram and Threads do not accept file uploads. They fetch the asset from a
 * URL you give them, which means this app must be reachable from Meta's servers
 * -- a public APP_URL (or a tunnel in development), not localhost.
 */
export function requirePublicUrl(m: ResolvedMedia, platform: string): string {
  if (!m.publicUrl) {
    throw new PublishError(
      `${platform} fetches media from a public URL, but ${m.filename} has none. ` +
        `Set APP_URL to a publicly reachable address (or run a tunnel such as "cloudflared tunnel --url http://localhost:3000").`,
    )
  }
  if (m.publicUrl.includes('localhost') || m.publicUrl.includes('127.0.0.1')) {
    throw new PublishError(
      `${platform} cannot fetch ${m.publicUrl} -- Meta's servers cannot reach localhost. Set APP_URL to a public address.`,
    )
  }
  return m.publicUrl
}

/**
 * Meta short-lived user tokens last ~1 hour; exchanging gives ~60 days. Page
 * tokens derived from a long-lived user token do not expire on their own.
 */
export async function exchangeForLongLived(shortToken: string): Promise<TokenSet> {
  const res = await api<{ access_token: string; expires_in?: number }>(
    `${GRAPH}/oauth/access_token?` +
      form({
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID!,
        client_secret: process.env.META_APP_SECRET!,
        fb_exchange_token: shortToken,
      }),
    { label: 'Meta long-lived token exchange' },
  )
  return {
    accessToken: res.access_token,
    expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : null,
  }
}

/** Meta returns a nested error object; surface the human-readable part. */
interface MetaErrorBody {
  error?: { message?: string; code?: number; is_transient?: boolean }
}

export function metaError(label: string, body: unknown): never {
  const e = (body as MetaErrorBody)?.error
  throw new PublishError(`${label}: ${e?.message ?? JSON.stringify(body)}`, {
    reauth: e?.code === 190,
    retryable: e?.is_transient === true,
  })
}

export const tokenOf = (a: DecryptedAccount) => {
  if (!a.accessToken) throw new PublishError('Meta account has no access token; reconnect it.', { reauth: true })
  return a.accessToken
}
