import fs from 'node:fs/promises'
import { api, bearer, form } from './http'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

const API = 'https://api.pinterest.com/v5'

export const pinterest: PlatformAdapter = {
  id: 'pinterest',
  label: 'Pinterest',
  color: '#E60023',
  capabilities: {
    maxTextLength: 800, // description
    requiresMedia: true,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: false,
    altText: true,
    image: { maxCount: 5, formats: ['jpg', 'jpeg', 'png'], maxBytes: 20_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov'], maxBytes: 2_000_000_000, minDurationSec: 4, maxDurationSec: 900 },
    options: [
      { key: 'boardId', label: 'Board ID', type: 'text', required: true },
      { key: 'title', label: 'Pin title', type: 'text', required: false, help: 'Max 100 characters.' },
      { key: 'link', label: 'Destination link', type: 'text', required: false },
    ],
  },
  connect: {
    kind: 'oauth2',
    pkce: false,
    scopes: ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'],
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/pins-create',
  },
  caveats: [
    'Pinterest apps start in trial mode with a 1,000-call/day cap and only work on your own account until you request standard access.',
    'Video pins require the media to be uploaded through their registration flow, which can take minutes to transcode.',
  ],

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    if (!token) throw new PublishError('Pinterest account has no access token.', { reauth: true })
    const boardId = ctx.options.boardId as string
    if (!boardId) throw new PublishError('Pinterest needs a board ID.')

    const image = ctx.media.find((m) => m.kind === 'image')
    const video = ctx.media.find((m) => m.kind === 'video')

    const body: Record<string, unknown> = {
      board_id: boardId,
      title: String(ctx.options.title ?? '').slice(0, 100) || undefined,
      description: ctx.text.slice(0, 800),
      link: ctx.options.link || undefined,
      alt_text: image?.altText ?? undefined,
    }

    if (video) {
      // Video pins: register the upload, PUT to S3, then create the pin with the media_id.
      const reg = await api<{ media_id: string; upload_url: string; upload_parameters: Record<string, string> }>(
        `${API}/media`,
        {
          label: 'Pinterest media register',
          method: 'POST',
          headers: { ...bearer(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_type: 'video' }),
        },
      )
      const fd = new FormData()
      for (const [k, v] of Object.entries(reg.upload_parameters)) fd.set(k, v)
      fd.set('file', new Blob([await fs.readFile(video.path)], { type: video.mimeType }), video.filename)
      const up = await fetch(reg.upload_url, { method: 'POST', body: fd })
      if (!up.ok) throw new PublishError(`Pinterest video upload: HTTP ${up.status}`, { retryable: up.status >= 500 })
      ctx.log(`registered video media ${reg.media_id}`)

      const cover = ctx.media.find((m) => m.kind === 'image')
      body.media_source = {
        source_type: 'video_id',
        media_id: reg.media_id,
        cover_image_url: cover?.publicUrl ?? undefined,
      }
    } else if (image) {
      // Pinterest accepts either a URL it fetches or base64 bytes. Base64 avoids
      // needing a public APP_URL, at the cost of a bigger request.
      if (image.publicUrl) {
        body.media_source = { source_type: 'image_url', url: image.publicUrl }
      } else {
        body.media_source = {
          source_type: 'image_base64',
          content_type: image.mimeType,
          data: (await fs.readFile(image.path)).toString('base64'),
        }
      }
    } else {
      throw new PublishError('Pinterest needs an image or video.')
    }

    const res = await api<{ id: string }>(`${API}/pins`, {
      label: 'Pinterest create pin',
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { remoteId: res.id, remoteUrl: `https://www.pinterest.com/pin/${res.id}/`, raw: res }
  },

  async refresh(account) {
    if (!account.refreshToken) throw new PublishError('Pinterest account has no refresh token; reconnect it.', { reauth: true })
    const basic = Buffer.from(`${process.env.PINTEREST_APP_ID}:${process.env.PINTEREST_APP_SECRET}`).toString('base64')
    const res = await api<{ access_token: string; expires_in: number; refresh_token?: string }>(`${API}/oauth/token`, {
      label: 'Pinterest token refresh',
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: account.refreshToken }),
    })
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? account.refreshToken,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
    }
  },
}
