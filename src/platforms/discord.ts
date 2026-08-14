import fs from 'node:fs/promises'
import { api } from './http'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

/** Webhook URL only. Nothing to register, nothing to review. */
export const discord: PlatformAdapter = {
  id: 'discord',
  label: 'Discord',
  color: '#5865F2',
  capabilities: {
    maxTextLength: 2000,
    requiresMedia: false,
    textOptional: true,
    mixedMedia: true,
    nativeScheduling: false,
    altText: false,
    image: { maxCount: 10, formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'], maxBytes: 25_000_000 },
    video: { maxCount: 10, formats: ['mp4', 'mov', 'webm'], maxBytes: 25_000_000 },
  },
  connect: {
    kind: 'token',
    docsUrl: 'https://support.discord.com/hc/en-us/articles/228383668',
    fields: [
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true, help: 'Channel settings -> Integrations -> Webhooks -> New Webhook -> Copy URL.' },
      { key: 'username', label: 'Override bot name', type: 'text', required: false },
    ],
  },
  caveats: ['Free servers cap uploads at 25MB per message regardless of the file limits above.'],

  async publish(ctx: PublishContext) {
    const url = ctx.account.meta.webhookUrl as string
    if (!url) throw new PublishError('Discord account has no webhook URL.', { reauth: true })

    const body = new FormData()
    const payload: Record<string, unknown> = { content: ctx.text.slice(0, 2000) }
    if (ctx.account.meta.username) payload.username = ctx.account.meta.username
    body.set('payload_json', JSON.stringify(payload))
    for (const [i, m] of ctx.media.entries()) {
      body.set(`files[${i}]`, new Blob([await fs.readFile(m.path)], { type: m.mimeType }), m.filename)
    }

    // ?wait=true makes Discord return the created message instead of 204.
    const res = await api<{ id: string; channel_id: string }>(`${url}?wait=true`, {
      label: 'Discord webhook',
      method: 'POST',
      body,
    })
    return { remoteId: res.id, raw: res }
  },
}
