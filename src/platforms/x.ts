import fs from 'node:fs/promises'
import { api, bearer, form, poll } from './http'
import { PublishError, type PlatformAdapter, type PublishContext, type ResolvedMedia } from './types'

const API = 'https://api.x.com/2'
const UPLOAD = 'https://api.x.com/2/media/upload'

/**
 * X media upload is chunked: INIT -> APPEND(n) -> FINALIZE, then for video a
 * STATUS poll while the transcode finishes. Images are done after FINALIZE.
 */
async function uploadMedia(token: string, m: ResolvedMedia, log: (s: string) => void): Promise<string> {
  const category = m.kind === 'video' ? 'tweet_video' : 'tweet_image'

  const init = await api<{ data: { id: string } }>(UPLOAD, {
    label: 'X media INIT',
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ command: 'INIT', total_bytes: m.bytes, media_type: m.mimeType, media_category: category }),
  })
  const mediaId = init.data.id

  const buf = await fs.readFile(m.path)
  const CHUNK = 4 * 1024 * 1024
  for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
    const body = new FormData()
    body.set('command', 'APPEND')
    body.set('media_id', mediaId)
    body.set('segment_index', String(seg))
    body.set('media', new Blob([buf.subarray(i, i + CHUNK)]))
    await api(UPLOAD, { label: `X media APPEND ${seg}`, method: 'POST', headers: bearer(token), body, parse: 'none' })
  }
  log(`uploaded ${m.filename} in ${Math.ceil(buf.length / CHUNK)} chunk(s)`)

  const fin = await api<{ data: { id: string; processing_info?: { state: string } } }>(UPLOAD, {
    label: 'X media FINALIZE',
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ command: 'FINALIZE', media_id: mediaId }),
  })

  if (fin.data.processing_info) {
    type Status = { data?: { processing_info?: { state: string; error?: { message?: string } } } }
    await poll(
      () => api<Status>(`${UPLOAD}?command=STATUS&media_id=${mediaId}`, { label: 'X media STATUS', headers: bearer(token) }),
      (v) => {
        const info = v?.data?.processing_info
        if (!info || info.state === 'succeeded') return 'done'
        if (info.state === 'failed') return { error: info.error?.message ?? 'transcode failed' }
        return 'wait'
      },
      { label: 'X video processing' },
    )
  }

  if (m.altText) {
    await api(`${API}/media/metadata`, {
      label: 'X alt text',
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: mediaId, metadata: { alt_text: { text: m.altText.slice(0, 1000) } } }),
      parse: 'none',
    }).catch(() => log('alt text rejected, continuing'))
  }

  return mediaId
}

export const x: PlatformAdapter = {
  id: 'x',
  label: 'X',
  color: '#000000',
  capabilities: {
    maxTextLength: 280,
    requiresMedia: false,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: false,
    altText: true,
    image: { maxCount: 4, formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'], maxBytes: 5_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov'], maxBytes: 512_000_000, maxDurationSec: 140 },
  },
  connect: {
    kind: 'oauth2',
    pkce: true,
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
    docsUrl: 'https://developer.x.com/en/portal/dashboard',
  },
  caveats: [
    'Free tier allows 500 posts per month per app. Basic tier ($200/mo) raises this.',
    'Long-form text over 280 chars needs a Premium account on the posting user.',
  ],

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    if (!token) throw new PublishError('X account has no access token.', { reauth: true })

    const mediaIds: string[] = []
    for (const m of ctx.media) mediaIds.push(await uploadMedia(token, m, ctx.log))

    const body: Record<string, unknown> = { text: ctx.text }
    if (mediaIds.length) body.media = { media_ids: mediaIds }
    if (ctx.options.replySettings) body.reply_settings = ctx.options.replySettings

    const res = await api<{ data: { id: string } }>(`${API}/tweets`, {
      label: 'X create post',
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const handle = ctx.account.handle ?? 'i'
    return { remoteId: res.data.id, remoteUrl: `https://x.com/${handle}/status/${res.data.id}`, raw: res }
  },

  async refresh(account) {
    if (!account.refreshToken) throw new PublishError('X account has no refresh token; reconnect it.', { reauth: true })
    const basic = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64')
    const res = await api<{ access_token: string; refresh_token?: string; expires_in: number }>(
      'https://api.x.com/2/oauth2/token',
      {
        label: 'X token refresh',
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: 'refresh_token', refresh_token: account.refreshToken }),
      },
    )
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? account.refreshToken,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
    }
  },
}
