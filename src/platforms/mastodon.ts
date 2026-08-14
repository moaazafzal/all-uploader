import fs from 'node:fs/promises'
import { api, bearer, poll } from './http'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

/**
 * Mastodon is per-instance: the base URL comes from the connected account, and
 * the token is a personal access token the user creates on their own instance.
 */
const base = (ctx: PublishContext) => {
  const url = ctx.account.meta.instanceUrl as string | undefined
  if (!url) throw new PublishError('Mastodon account has no instance URL.', { reauth: true })
  return url.replace(/\/$/, '')
}

export const mastodon: PlatformAdapter = {
  id: 'mastodon',
  label: 'Mastodon',
  color: '#6364FF',
  capabilities: {
    // Instance-configurable; 500 is the default and the safe assumption.
    maxTextLength: 500,
    requiresMedia: false,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: true,
    altText: true,
    image: { maxCount: 4, formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'], maxBytes: 16_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov', 'webm'], maxBytes: 99_000_000 },
    options: [
      {
        key: 'visibility', label: 'Visibility', type: 'select', required: false, default: 'public',
        choices: [
          { value: 'public', label: 'Public' },
          { value: 'unlisted', label: 'Unlisted' },
          { value: 'private', label: 'Followers only' },
          { value: 'direct', label: 'Direct' },
        ],
      },
      { key: 'spoilerText', label: 'Content warning', type: 'text', required: false },
      { key: 'sensitive', label: 'Mark media sensitive', type: 'boolean', required: false, default: false },
    ],
  },
  connect: {
    kind: 'credentials',
    docsUrl: 'https://docs.joinmastodon.org/client/token/',
    fields: [
      { key: 'instanceUrl', label: 'Instance URL', type: 'text', required: true, help: 'e.g. https://mastodon.social' },
      { key: 'accessToken', label: 'Access token', type: 'text', required: true, help: 'Preferences -> Development -> New application, scopes: read write. Then copy "Your access token".' },
    ],
  },

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    const host = base(ctx)

    const mediaIds: string[] = []
    for (const m of ctx.media) {
      const body = new FormData()
      body.set('file', new Blob([await fs.readFile(m.path)], { type: m.mimeType }), m.filename)
      if (m.altText) body.set('description', m.altText)

      const up = await api<{ id: string; url: string | null }>(`${host}/api/v2/media`, {
        label: 'Mastodon media upload',
        method: 'POST',
        headers: bearer(token),
        body,
      })

      // v2 returns 202 with url:null while transcoding; the status endpoint
      // 206s until the asset is ready to attach.
      if (!up.url) {
        await poll(
          () => api<any>(`${host}/api/v1/media/${up.id}`, { label: 'Mastodon media status', headers: bearer(token) }),
          (v) => (v?.url ? 'done' : 'wait'),
          { label: 'Mastodon media processing', attempts: 20, intervalMs: 3000 },
        )
      }
      mediaIds.push(up.id)
      ctx.log(`uploaded ${m.filename}`)
    }

    const payload: Record<string, unknown> = {
      status: ctx.text,
      visibility: ctx.options.visibility ?? 'public',
    }
    if (mediaIds.length) payload.media_ids = mediaIds
    if (ctx.options.spoilerText) payload.spoiler_text = ctx.options.spoilerText
    if (ctx.options.sensitive) payload.sensitive = true

    const res = await api<{ id: string; url: string }>(`${host}/api/v1/statuses`, {
      label: 'Mastodon create status',
      method: 'POST',
      headers: {
        ...bearer(token),
        'Content-Type': 'application/json',
        // Retried publishes reuse this key, so a timeout that actually
        // succeeded does not produce a duplicate toot.
        'Idempotency-Key': String(ctx.options.__idempotencyKey ?? ''),
      },
      body: JSON.stringify(payload),
    })

    return { remoteId: res.id, remoteUrl: res.url, raw: res }
  },
}
