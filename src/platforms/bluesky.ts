import fs from 'node:fs/promises'
import { AtpAgent, RichText } from '@atproto/api'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

/**
 * Bluesky needs no app registration -- the user creates an app password in
 * their own settings and pastes it. Easiest platform in the set.
 */
async function agentFor(ctx: PublishContext) {
  const service = (ctx.account.meta.service as string) ?? 'https://bsky.social'
  const agent = new AtpAgent({ service })
  const identifier = ctx.account.handle
  const password = ctx.account.accessToken
  if (!identifier || !password) throw new PublishError('Bluesky account is missing its app password.', { reauth: true })
  try {
    await agent.login({ identifier, password })
  } catch (err) {
    throw new PublishError(`Bluesky login failed: ${(err as Error).message}`, { reauth: true })
  }
  return agent
}

export const bluesky: PlatformAdapter = {
  id: 'bluesky',
  label: 'Bluesky',
  color: '#0085FF',
  capabilities: {
    maxTextLength: 300,
    requiresMedia: false,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: false,
    altText: true,
    image: { maxCount: 4, formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'], maxBytes: 1_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov'], maxBytes: 100_000_000, maxDurationSec: 180 },
  },
  connect: {
    kind: 'credentials',
    docsUrl: 'https://bsky.app/settings/app-passwords',
    fields: [
      { key: 'handle', label: 'Handle', type: 'text', required: true, help: 'e.g. yourname.bsky.social' },
      { key: 'appPassword', label: 'App password', type: 'text', required: true, help: 'Settings -> Privacy and security -> App passwords. Not your login password.' },
      { key: 'service', label: 'PDS URL', type: 'text', required: false, default: 'https://bsky.social', help: 'Leave as-is unless self-hosting a PDS.' },
    ],
  },
  caveats: ['Images are capped at 1MB after upload -- large photos are downscaled automatically before posting.'],

  async publish(ctx: PublishContext) {
    const agent = await agentFor(ctx)

    // RichText detects links, mentions and hashtags and produces the facet
    // ranges Bluesky needs; without it, URLs post as dead plain text.
    const rt = new RichText({ text: ctx.text })
    await rt.detectFacets(agent)

    const record: Record<string, unknown> = {
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
    }

    const images = ctx.media.filter((m) => m.kind === 'image')
    const video = ctx.media.find((m) => m.kind === 'video')

    if (video) {
      const blob = await agent.uploadBlob(await fs.readFile(video.path), { encoding: video.mimeType })
      record.embed = {
        $type: 'app.bsky.embed.video',
        video: blob.data.blob,
        alt: video.altText ?? undefined,
      }
      ctx.log(`uploaded video ${video.filename}`)
    } else if (images.length) {
      const uploaded = []
      for (const img of images) {
        const blob = await agent.uploadBlob(await fs.readFile(img.path), { encoding: img.mimeType })
        uploaded.push({
          image: blob.data.blob,
          alt: img.altText ?? '',
          aspectRatio: img.width && img.height ? { width: img.width, height: img.height } : undefined,
        })
      }
      record.embed = { $type: 'app.bsky.embed.images', images: uploaded }
      ctx.log(`uploaded ${uploaded.length} image(s)`)
    }

    const res = await agent.post(record as never)
    const rkey = res.uri.split('/').pop()
    return {
      remoteId: res.uri,
      remoteUrl: `https://bsky.app/profile/${ctx.account.handle}/post/${rkey}`,
      raw: res,
    }
  },
}
