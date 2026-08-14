import fs from 'node:fs/promises'
import { api, form } from './http'
import { GRAPH, GRAPH_VIDEO, tokenOf } from './meta-shared'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

/**
 * Facebook Pages accepts real uploads (unlike Instagram), so media goes up as
 * multipart. Multi-photo posts use the unpublished-photo trick: upload each
 * with published=false, then attach the returned ids to a feed post.
 */
export const facebook: PlatformAdapter = {
  id: 'facebook',
  label: 'Facebook Page',
  color: '#1877F2',
  capabilities: {
    maxTextLength: 63_206,
    requiresMedia: false,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: true,
    altText: false,
    image: { maxCount: 10, formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'], maxBytes: 10_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov'], maxBytes: 10_000_000_000, maxDurationSec: 14_400 },
    options: [{ key: 'link', label: 'Link to attach', type: 'text', required: false }],
  },
  connect: {
    kind: 'oauth2',
    pkce: false,
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management'],
    docsUrl: 'https://developers.facebook.com/docs/pages-api/posts',
  },
  caveats: [
    'pages_manage_posts requires Meta App Review to work on Pages you do not administer as a test user.',
    'You must be an admin of the Page. Personal profiles cannot be posted to by any API.',
  ],

  async publish(ctx: PublishContext) {
    const token = tokenOf(ctx.account)
    const pageId = ctx.account.meta.pageId as string
    if (!pageId) throw new PublishError('Facebook account is missing its Page ID; reconnect it.', { reauth: true })

    const video = ctx.media.find((m) => m.kind === 'video')
    const images = ctx.media.filter((m) => m.kind === 'image')

    if (video) {
      const body = new FormData()
      body.set('access_token', token)
      body.set('description', ctx.text)
      body.set('source', new Blob([await fs.readFile(video.path)], { type: video.mimeType }), video.filename)
      const res = await api<{ id: string }>(`${GRAPH_VIDEO}/${pageId}/videos`, {
        label: 'Facebook video upload',
        method: 'POST',
        body,
        timeoutMs: 900_000,
      })
      ctx.log(`uploaded video ${video.filename}`)
      return { remoteId: res.id, remoteUrl: `https://facebook.com/${res.id}`, raw: res }
    }

    if (images.length === 1) {
      const m = images[0]
      const body = new FormData()
      body.set('access_token', token)
      body.set('caption', ctx.text)
      body.set('source', new Blob([await fs.readFile(m.path)], { type: m.mimeType }), m.filename)
      const res = await api<{ id: string; post_id?: string }>(`${GRAPH}/${pageId}/photos`, {
        label: 'Facebook photo upload',
        method: 'POST',
        body,
      })
      const id = res.post_id ?? res.id
      return { remoteId: id, remoteUrl: `https://facebook.com/${id}`, raw: res }
    }

    const attached: { media_fbid: string }[] = []
    for (const m of images) {
      const body = new FormData()
      body.set('access_token', token)
      body.set('published', 'false')
      body.set('source', new Blob([await fs.readFile(m.path)], { type: m.mimeType }), m.filename)
      const up = await api<{ id: string }>(`${GRAPH}/${pageId}/photos`, {
        label: `Facebook stage photo ${m.filename}`,
        method: 'POST',
        body,
      })
      attached.push({ media_fbid: up.id })
    }
    if (attached.length) ctx.log(`staged ${attached.length} photos`)

    const payload = form({
      access_token: token,
      message: ctx.text,
      link: ctx.options.link as string | undefined,
    })
    if (attached.length) payload.set('attached_media', JSON.stringify(attached))

    const res = await api<{ id: string }>(`${GRAPH}/${pageId}/feed`, {
      label: 'Facebook create post',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload,
    })
    return { remoteId: res.id, remoteUrl: `https://facebook.com/${res.id}`, raw: res }
  },
}
