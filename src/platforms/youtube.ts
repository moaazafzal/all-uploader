import fs from 'node:fs/promises'
import { api, bearer, form } from './http'
import { PublishError, type Issue, type PlatformAdapter, type PublishContext } from './types'

/**
 * YouTube uses a resumable upload: POST the metadata to get a session URL, then
 * PUT the bytes to that URL. A video under 60s in portrait becomes a Short
 * automatically -- there is no "post a Short" endpoint.
 */
export const youtube: PlatformAdapter = {
  id: 'youtube',
  label: 'YouTube',
  color: '#FF0000',
  capabilities: {
    maxTextLength: 5000, // description
    requiresMedia: true,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: true,
    altText: false,
    video: { maxCount: 1, formats: ['mp4', 'mov', 'avi', 'webm', 'mkv'], maxBytes: 256_000_000_000, maxDurationSec: 43_200 },
    options: [
      { key: 'title', label: 'Title', type: 'text', required: true, help: 'Max 100 characters. Required by YouTube.' },
      {
        key: 'privacyStatus', label: 'Privacy', type: 'select', required: false, default: 'private',
        choices: [
          { value: 'private', label: 'Private' },
          { value: 'unlisted', label: 'Unlisted' },
          { value: 'public', label: 'Public' },
        ],
      },
      { key: 'tags', label: 'Tags (comma separated)', type: 'text', required: false },
      { key: 'madeForKids', label: 'Made for kids', type: 'boolean', required: false, default: false },
    ],
  },
  connect: {
    kind: 'oauth2',
    pkce: false,
    scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
    docsUrl: 'https://developers.google.com/youtube/v3/guides/uploading_a_video',
  },
  caveats: [
    'Default quota is 10,000 units/day and an upload costs 1,600 -- about 6 uploads per day until you request an increase.',
    'Unverified projects have uploads locked to private. Verification is a separate Google review.',
    'A video is a Short only if it is under 60 seconds and square or vertical. There is no API flag for it.',
  ],

  validate({ options, media }): Issue[] {
    const issues: Issue[] = []
    const title = options.title as string | undefined
    if (title && title.length > 100) {
      issues.push({ level: 'error', field: 'options', message: `Title is ${title.length} characters, YouTube's limit is 100.` })
    }
    if (title && /[<>]/.test(title)) {
      issues.push({ level: 'error', field: 'options', message: 'YouTube rejects < and > in titles.' })
    }
    const v = media.find((m) => m.kind === 'video')
    if (v?.durationMs && v.width && v.height) {
      const isShort = v.durationMs <= 60_000 && v.width <= v.height
      if (isShort) issues.push({ level: 'warning', field: 'media', message: 'Vertical and under 60s -- YouTube will file this as a Short.' })
    }
    return issues
  },

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    if (!token) throw new PublishError('YouTube account has no access token.', { reauth: true })
    const video = ctx.media.find((m) => m.kind === 'video')
    if (!video) throw new PublishError('YouTube needs a video file.')

    const tags = String(ctx.options.tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    const metadata = {
      snippet: {
        title: String(ctx.options.title ?? '').slice(0, 100) || video.filename,
        description: ctx.text.slice(0, 5000),
        tags: tags.length ? tags : undefined,
        categoryId: (ctx.options.categoryId as string) ?? '22',
      },
      status: {
        privacyStatus: (ctx.options.privacyStatus as string) ?? 'private',
        selfDeclaredMadeForKids: Boolean(ctx.options.madeForKids),
      },
    }

    const init = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          ...bearer(token),
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(video.bytes),
          'X-Upload-Content-Type': video.mimeType,
        },
        body: JSON.stringify(metadata),
      },
    )
    if (!init.ok) {
      const text = await init.text().catch(() => '')
      throw new PublishError(`YouTube upload init: HTTP ${init.status} ${text}`, {
        status: init.status,
        reauth: init.status === 401,
        // 403 here is nearly always quotaExceeded -- retrying today will not help.
        retryable: init.status >= 500,
      })
    }
    const sessionUrl = init.headers.get('location')
    if (!sessionUrl) throw new PublishError('YouTube did not return a resumable session URL.', { retryable: true })

    ctx.log(`resumable session opened, uploading ${(video.bytes / 1e6).toFixed(1)}MB`)
    const put = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Type': video.mimeType, 'Content-Length': String(video.bytes) },
      body: new Uint8Array(await fs.readFile(video.path)),
    })
    if (!put.ok) {
      throw new PublishError(`YouTube upload: HTTP ${put.status} ${await put.text().catch(() => '')}`, {
        retryable: put.status >= 500,
      })
    }
    const res = (await put.json()) as { id: string }
    return { remoteId: res.id, remoteUrl: `https://www.youtube.com/watch?v=${res.id}`, raw: res }
  },

  async refresh(account) {
    if (!account.refreshToken) throw new PublishError('YouTube account has no refresh token; reconnect it.', { reauth: true })
    const res = await api<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      label: 'Google token refresh',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
    })
    return {
      accessToken: res.access_token,
      refreshToken: account.refreshToken,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
    }
  },
}
