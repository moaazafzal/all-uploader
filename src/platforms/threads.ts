import { api, form, poll } from './http'
import { requirePublicUrl, tokenOf } from './meta-shared'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

/** Threads has its own host and its own token -- it is not the Facebook graph. */
const THREADS = 'https://graph.threads.net/v1.0'

async function createContainer(userId: string, token: string, params: Record<string, string | undefined>) {
  const res = await api<{ id: string }>(`${THREADS}/${userId}/threads`, {
    label: 'Threads create container',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ ...params, access_token: token }),
  })
  return res.id
}

async function waitForContainer(id: string, token: string) {
  await poll(
    () =>
      api<{ status: string; error_message?: string }>(
        `${THREADS}/${id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`,
        { label: 'Threads container status' },
      ),
    (v) => {
      if (v.status === 'FINISHED') return 'done'
      if (v.status === 'ERROR') return { error: v.error_message ?? 'container failed' }
      if (v.status === 'EXPIRED') return { error: 'container expired' }
      return 'wait'
    },
    { label: 'Threads media processing', attempts: 40, intervalMs: 4000 },
  )
}

export const threads: PlatformAdapter = {
  id: 'threads',
  label: 'Threads',
  color: '#000000',
  capabilities: {
    maxTextLength: 500,
    requiresMedia: false,
    textOptional: true,
    mixedMedia: true,
    nativeScheduling: false,
    altText: true,
    image: { maxCount: 20, formats: ['jpg', 'jpeg', 'png'], maxBytes: 8_000_000 },
    video: { maxCount: 20, formats: ['mp4', 'mov'], maxBytes: 1_000_000_000, maxDurationSec: 300 },
  },
  connect: {
    kind: 'oauth2',
    pkce: false,
    scopes: ['threads_basic', 'threads_content_publish'],
    docsUrl: 'https://developers.facebook.com/docs/threads',
  },
  caveats: [
    'Threads uses a separate OAuth flow from Facebook/Instagram even though it is a Meta product.',
    'Media is fetched from a public URL, so APP_URL must be internet-reachable.',
    'Rate limit: 250 posts per 24 hours per user.',
  ],

  async publish(ctx: PublishContext) {
    const token = tokenOf(ctx.account)
    const userId = ctx.account.meta.threadsUserId as string
    if (!userId) throw new PublishError('Threads account is missing its user ID; reconnect it.', { reauth: true })

    const text = ctx.text.slice(0, 500)
    let containerId: string

    if (ctx.media.length === 0) {
      containerId = await createContainer(userId, token, { media_type: 'TEXT', text })
    } else if (ctx.media.length === 1) {
      const m = ctx.media[0]
      const url = requirePublicUrl(m, 'Threads')
      containerId = await createContainer(userId, token, {
        media_type: m.kind === 'video' ? 'VIDEO' : 'IMAGE',
        ...(m.kind === 'video' ? { video_url: url } : { image_url: url }),
        text,
        alt_text: m.altText ?? undefined,
      })
      await waitForContainer(containerId, token)
    } else {
      const children: string[] = []
      for (const m of ctx.media) {
        const url = requirePublicUrl(m, 'Threads')
        const childId = await createContainer(userId, token, {
          is_carousel_item: 'true',
          media_type: m.kind === 'video' ? 'VIDEO' : 'IMAGE',
          ...(m.kind === 'video' ? { video_url: url } : { image_url: url }),
          alt_text: m.altText ?? undefined,
        })
        await waitForContainer(childId, token)
        children.push(childId)
      }
      containerId = await createContainer(userId, token, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        text,
      })
      await waitForContainer(containerId, token)
    }

    ctx.log(`container ${containerId} ready`)
    const res = await api<{ id: string }>(`${THREADS}/${userId}/threads_publish`, {
      label: 'Threads publish',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ creation_id: containerId, access_token: token }),
    })

    const perma = await api<{ permalink?: string }>(
      `${THREADS}/${res.id}?fields=permalink&access_token=${encodeURIComponent(token)}`,
      { label: 'Threads permalink' },
    ).catch(() => ({ permalink: undefined }))

    return { remoteId: res.id, remoteUrl: perma.permalink, raw: res }
  },

  async refresh(account) {
    if (!account.accessToken) throw new PublishError('No Threads token to refresh.', { reauth: true })
    // Threads long-lived tokens are refreshed in place, not via a refresh_token.
    const res = await api<{ access_token: string; expires_in: number }>(
      `${THREADS}/refresh_access_token?` +
        form({ grant_type: 'th_refresh_token', access_token: account.accessToken }),
      { label: 'Threads token refresh' },
    )
    return { accessToken: res.access_token, expiresAt: new Date(Date.now() + res.expires_in * 1000) }
  },
}
