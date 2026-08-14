import fs from 'node:fs/promises'
import { api } from './http'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

/** Bot token + channel id. No OAuth, no review -- create a bot with @BotFather. */
export const telegram: PlatformAdapter = {
  id: 'telegram',
  label: 'Telegram',
  color: '#26A5E4',
  capabilities: {
    maxTextLength: 1024, // caption limit when media is attached; 4096 for text-only
    requiresMedia: false,
    textOptional: true,
    mixedMedia: true,
    nativeScheduling: false,
    altText: false,
    image: { maxCount: 10, formats: ['jpg', 'jpeg', 'png', 'webp'], maxBytes: 10_000_000 },
    video: { maxCount: 10, formats: ['mp4', 'mov'], maxBytes: 50_000_000 },
  },
  connect: {
    kind: 'token',
    docsUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    fields: [
      { key: 'botToken', label: 'Bot token', type: 'text', required: true, help: 'From @BotFather.' },
      { key: 'chatId', label: 'Channel or chat ID', type: 'text', required: true, help: 'e.g. @mychannel or -1001234567890. Add the bot as an admin first.' },
    ],
  },

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    const chatId = ctx.account.meta.chatId as string
    if (!token || !chatId) throw new PublishError('Telegram account is missing its bot token or chat ID.', { reauth: true })
    const base = `https://api.telegram.org/bot${token}`

    if (ctx.media.length === 0) {
      const res = await api<{ result: { message_id: number } }>(`${base}/sendMessage`, {
        label: 'Telegram sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: ctx.text.slice(0, 4096) }),
      })
      return { remoteId: String(res.result.message_id) }
    }

    // A single media item posts directly; two or more go as an album, where
    // only the first item may carry the caption.
    if (ctx.media.length === 1) {
      const m = ctx.media[0]
      const method = m.kind === 'video' ? 'sendVideo' : 'sendPhoto'
      const body = new FormData()
      body.set('chat_id', chatId)
      if (ctx.text) body.set('caption', ctx.text.slice(0, 1024))
      body.set(m.kind === 'video' ? 'video' : 'photo', new Blob([await fs.readFile(m.path)], { type: m.mimeType }), m.filename)
      const res = await api<{ result: { message_id: number } }>(`${base}/${method}`, { label: `Telegram ${method}`, method: 'POST', body })
      return { remoteId: String(res.result.message_id) }
    }

    const body = new FormData()
    body.set('chat_id', chatId)
    const group = ctx.media.map((m, i) => ({
      type: m.kind === 'video' ? 'video' : 'photo',
      media: `attach://file${i}`,
      ...(i === 0 && ctx.text ? { caption: ctx.text.slice(0, 1024) } : {}),
    }))
    body.set('media', JSON.stringify(group))
    for (const [i, m] of ctx.media.entries()) {
      body.set(`file${i}`, new Blob([await fs.readFile(m.path)], { type: m.mimeType }), m.filename)
    }
    const res = await api<{ result: { message_id: number }[] }>(`${base}/sendMediaGroup`, { label: 'Telegram sendMediaGroup', method: 'POST', body })
    ctx.log(`sent album of ${ctx.media.length}`)
    return { remoteId: String(res.result[0].message_id) }
  },
}
