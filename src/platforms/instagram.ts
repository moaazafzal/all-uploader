import { api, form, poll } from './http'
import { GRAPH, requirePublicUrl, tokenOf } from './meta-shared'
import { PublishError, type Issue, type PlatformAdapter, type PublishContext } from './types'

/**
 * Instagram publishing is a three-step container dance:
 *   1. create a media container (Instagram fetches the file from a public URL)
 *   2. poll the container until status_code is FINISHED
 *   3. publish the container
 * Carousels add a layer: each child is its own container first.
 */
async function createContainer(igUserId: string, token: string, params: Record<string, string | undefined>) {
  const res = await api<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    label: 'Instagram create container',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ ...params, access_token: token }),
  })
  return res.id
}

async function waitForContainer(containerId: string, token: string, label: string) {
  await poll(
    () =>
      api<{ status_code: string; status?: string }>(
        `${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
        { label: 'Instagram container status' },
      ),
    (v) => {
      if (v.status_code === 'FINISHED') return 'done'
      if (v.status_code === 'ERROR') return { error: v.status ?? 'container processing failed' }
      if (v.status_code === 'EXPIRED') return { error: 'container expired before publish' }
      return 'wait'
    },
    // Reels transcode slowly; 5 minutes of headroom.
    { label, attempts: 60, intervalMs: 5000 },
  )
}

export const instagram: PlatformAdapter = {
  id: 'instagram',
  label: 'Instagram',
  color: '#E4405F',
  capabilities: {
    maxTextLength: 2200,
    requiresMedia: true,
    textOptional: true,
    mixedMedia: true, // carousels may mix images and video
    nativeScheduling: false,
    altText: false,
    image: {
      maxCount: 10, formats: ['jpg', 'jpeg', 'png'], maxBytes: 8_000_000,
      aspectRatio: [0.8, 1.91], minWidth: 320,
    },
    video: {
      maxCount: 10, formats: ['mp4', 'mov'], maxBytes: 1_000_000_000,
      minDurationSec: 3, maxDurationSec: 900, aspectRatio: [0.01, 10],
    },
    options: [
      { key: 'shareToFeed', label: 'Also show Reel in feed', type: 'boolean', required: false, default: true },
      { key: 'locationId', label: 'Location page ID', type: 'text', required: false },
    ],
  },
  connect: {
    kind: 'oauth2',
    pkce: false,
    scopes: [
      'instagram_basic', 'instagram_content_publish',
      'pages_show_list', 'pages_read_engagement', 'business_management',
    ],
    docsUrl: 'https://developers.facebook.com/docs/instagram-api/guides/content-publishing',
  },
  caveats: [
    'Requires an Instagram Business or Creator account linked to a Facebook Page. Personal accounts cannot use this API.',
    'instagram_content_publish needs Meta App Review before it works for accounts outside your app\'s test users.',
    'Instagram fetches media from a public URL -- APP_URL must be reachable from the internet, not localhost.',
    'Rate limit: 50 published posts per 24 hours per account.',
    'PNG with transparency and non-8-bit-sRGB JPEGs are commonly rejected -- flatten first.',
  ],

  validate({ media }): Issue[] {
    const issues: Issue[] = []
    if (media.length > 1 && media.length < 2) return issues
    if (media.some((m) => m.kind === 'video') && media.length === 1) {
      // Single video posts publish as a Reel; warn since that changes placement.
      issues.push({ level: 'warning', field: 'media', message: 'A single video posts as a Reel, not a feed video.' })
    }
    return issues
  },

  async publish(ctx: PublishContext) {
    const token = tokenOf(ctx.account)
    const igUserId = ctx.account.meta.igUserId as string
    if (!igUserId) throw new PublishError('Instagram account is missing its IG user ID; reconnect it.', { reauth: true })

    const caption = ctx.text.slice(0, 2200)
    let containerId: string

    if (ctx.media.length === 1) {
      const m = ctx.media[0]
      const url = requirePublicUrl(m, 'Instagram')
      containerId = await createContainer(igUserId, token, {
        caption,
        ...(m.kind === 'video'
          ? {
              media_type: 'REELS',
              video_url: url,
              share_to_feed: ctx.options.shareToFeed === false ? 'false' : 'true',
            }
          : { image_url: url }),
        location_id: ctx.options.locationId as string | undefined,
      })
      ctx.log(`created ${m.kind} container ${containerId}`)
      await waitForContainer(containerId, token, 'Instagram media processing')
    } else {
      // Carousel: children first, each with is_carousel_item.
      const children: string[] = []
      for (const m of ctx.media) {
        const url = requirePublicUrl(m, 'Instagram')
        const childId = await createContainer(igUserId, token, {
          is_carousel_item: 'true',
          ...(m.kind === 'video' ? { media_type: 'VIDEO', video_url: url } : { image_url: url }),
        })
        await waitForContainer(childId, token, `Instagram carousel item ${m.filename}`)
        children.push(childId)
      }
      ctx.log(`prepared ${children.length} carousel items`)
      containerId = await createContainer(igUserId, token, {
        media_type: 'CAROUSEL',
        caption,
        children: children.join(','),
        location_id: ctx.options.locationId as string | undefined,
      })
      await waitForContainer(containerId, token, 'Instagram carousel processing')
    }

    const published = await api<{ id: string }>(`${GRAPH}/${igUserId}/media_publish`, {
      label: 'Instagram publish',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ creation_id: containerId, access_token: token }),
    })

    // The permalink is a separate lookup; failure here must not fail the publish.
    const permalink = await api<{ permalink?: string }>(
      `${GRAPH}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`,
      { label: 'Instagram permalink' },
    ).catch(() => ({ permalink: undefined }))

    return { remoteId: published.id, remoteUrl: permalink.permalink, raw: published }
  },
}
