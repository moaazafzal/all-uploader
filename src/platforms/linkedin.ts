import fs from 'node:fs/promises'
import { api, bearer, form, poll } from './http'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

const API = 'https://api.linkedin.com/rest'
const VERSION = '202411'

const headers = (token: string) => ({
  ...bearer(token),
  'LinkedIn-Version': VERSION,
  'X-Restli-Protocol-Version': '2.0.0',
})

/**
 * LinkedIn uploads are register-then-PUT: ask for an upload URL scoped to the
 * owner URN, PUT the bytes, then reference the returned asset URN in the post.
 */
async function uploadImage(token: string, owner: string, path: string): Promise<string> {
  const reg = await api<{ value: { uploadUrl: string; image: string } }>(
    `${API}/images?action=initializeUpload`,
    {
      label: 'LinkedIn image init',
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    },
  )
  const res = await fetch(reg.value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: new Uint8Array(await fs.readFile(path)),
  })
  if (!res.ok) throw new PublishError(`LinkedIn image upload: HTTP ${res.status}`, { retryable: res.status >= 500 })
  return reg.value.image
}

async function uploadVideo(token: string, owner: string, path: string, bytes: number, log: (s: string) => void): Promise<string> {
  const reg = await api<{ value: { uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[]; video: string; uploadToken: string } }>(
    `${API}/videos?action=initializeUpload`,
    {
      label: 'LinkedIn video init',
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: bytes, uploadCaptions: false, uploadThumbnail: false } }),
    },
  )

  const buf = await fs.readFile(path)
  const etags: string[] = []
  for (const part of reg.value.uploadInstructions) {
    const res = await fetch(part.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(buf.subarray(part.firstByte, part.lastByte + 1)),
    })
    if (!res.ok) throw new PublishError(`LinkedIn video chunk: HTTP ${res.status}`, { retryable: res.status >= 500 })
    const etag = res.headers.get('etag')
    if (etag) etags.push(etag)
  }
  log(`uploaded video in ${reg.value.uploadInstructions.length} part(s)`)

  await api(`${API}/videos?action=finalizeUpload`, {
    label: 'LinkedIn video finalize',
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      finalizeUploadRequest: { video: reg.value.video, uploadToken: reg.value.uploadToken, uploadedPartIds: etags },
    }),
    parse: 'none',
  })

  // LinkedIn will reject a post referencing a video still marked PROCESSING.
  await poll(
    () => api<{ status: string }>(`${API}/videos/${encodeURIComponent(reg.value.video)}`, { label: 'LinkedIn video status', headers: headers(token) }),
    (v) => (v.status === 'AVAILABLE' ? 'done' : v.status === 'PROCESSING_FAILED' ? { error: 'transcode failed' } : 'wait'),
    { label: 'LinkedIn video processing', attempts: 40, intervalMs: 5000 },
  )
  return reg.value.video
}

export const linkedin: PlatformAdapter = {
  id: 'linkedin',
  label: 'LinkedIn',
  color: '#0A66C2',
  capabilities: {
    maxTextLength: 3000,
    requiresMedia: false,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: false,
    altText: true,
    image: { maxCount: 20, formats: ['jpg', 'jpeg', 'png', 'gif'], maxBytes: 10_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov'], maxBytes: 500_000_000, minDurationSec: 3, maxDurationSec: 1800 },
    options: [
      {
        key: 'visibility', label: 'Visibility', type: 'select', required: false, default: 'PUBLIC',
        choices: [{ value: 'PUBLIC', label: 'Anyone' }, { value: 'CONNECTIONS', label: 'Connections only' }],
      },
    ],
  },
  connect: {
    kind: 'oauth2',
    pkce: false,
    scopes: ['openid', 'profile', 'w_member_social'],
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api',
  },
  caveats: [
    'w_member_social posts as a person. Posting to a Company Page needs the Community Management API and a separate LinkedIn partner approval.',
    'Access tokens last 60 days and LinkedIn only issues refresh tokens to approved apps -- expect to reconnect periodically.',
  ],

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    if (!token) throw new PublishError('LinkedIn account has no access token.', { reauth: true })
    const owner = (ctx.account.meta.urn as string) ?? `urn:li:person:${ctx.account.externalId}`

    const body: Record<string, unknown> = {
      author: owner,
      commentary: ctx.text,
      visibility: (ctx.options.visibility as string) ?? 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }

    const video = ctx.media.find((m) => m.kind === 'video')
    const images = ctx.media.filter((m) => m.kind === 'image')

    if (video) {
      const urn = await uploadVideo(token, owner, video.path, video.bytes, ctx.log)
      body.content = { media: { id: urn, title: video.filename } }
    } else if (images.length === 1) {
      const urn = await uploadImage(token, owner, images[0].path)
      body.content = { media: { id: urn, altText: images[0].altText ?? undefined } }
    } else if (images.length > 1) {
      const urns: string[] = []
      for (const img of images) urns.push(await uploadImage(token, owner, img.path))
      ctx.log(`uploaded ${urns.length} images`)
      body.content = { multiImage: { images: urns.map((id, i) => ({ id, altText: images[i].altText ?? undefined })) } }
    }

    const res = await fetch(`${API}/posts`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new PublishError(`LinkedIn create post: HTTP ${res.status} ${text}`, {
        status: res.status,
        reauth: res.status === 401,
        retryable: res.status >= 500 || res.status === 429,
      })
    }
    // The post URN comes back in a header, not the body.
    const urn = res.headers.get('x-restli-id') ?? ''
    return { remoteId: urn, remoteUrl: urn ? `https://www.linkedin.com/feed/update/${urn}` : undefined }
  },

  async refresh(account) {
    if (!account.refreshToken) throw new PublishError('LinkedIn issued no refresh token; reconnect the account.', { reauth: true })
    const res = await api<{ access_token: string; refresh_token?: string; expires_in: number }>(
      'https://www.linkedin.com/oauth/v2/accessToken',
      {
        label: 'LinkedIn token refresh',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'refresh_token',
          refresh_token: account.refreshToken,
          client_id: process.env.LINKEDIN_CLIENT_ID!,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
        }),
      },
    )
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? account.refreshToken,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
    }
  },
}
