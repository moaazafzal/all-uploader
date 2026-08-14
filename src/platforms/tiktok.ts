import fs from 'node:fs/promises'
import { api, bearer, form, poll } from './http'
import { PublishError, type Issue, type PlatformAdapter, type PublishContext } from './types'

const API = 'https://open.tiktokapis.com/v2'

interface CreatorInfo {
  data: {
    creator_username: string
    privacy_level_options: string[]
    comment_disabled: boolean
    duet_disabled: boolean
    stitch_disabled: boolean
    max_video_post_duration_sec: number
  }
}

/**
 * TikTok requires creator_info to be queried immediately before posting -- it
 * returns which privacy levels this creator actually allows, and posting with a
 * level not in that list is rejected. It also tells us whether the app is still
 * unaudited (only SELF_ONLY offered).
 */
async function creatorInfo(token: string): Promise<CreatorInfo['data']> {
  const res = await api<CreatorInfo>(`${API}/post/publish/creator_info/query/`, {
    label: 'TikTok creator info',
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json; charset=UTF-8' },
  })
  return res.data
}

/** Chunked upload into the signed URL TikTok hands back from init. */
async function uploadFile(uploadUrl: string, path: string, mimeType: string, size: number, log: (s: string) => void) {
  const buf = await fs.readFile(path)
  // TikTok wants 5MB-64MB chunks, and a single chunk when the file is under 64MB.
  const CHUNK = 64 * 1024 * 1024
  if (size <= CHUNK) {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(size),
        'Content-Range': `bytes 0-${size - 1}/${size}`,
      },
      body: new Uint8Array(buf),
    })
    if (!res.ok) throw new PublishError(`TikTok upload: HTTP ${res.status} ${await res.text().catch(() => '')}`, { retryable: res.status >= 500 })
    log(`uploaded ${(size / 1e6).toFixed(1)}MB in one chunk`)
    return
  }
  for (let start = 0; start < size; start += CHUNK) {
    const end = Math.min(start + CHUNK, size) - 1
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
      body: new Uint8Array(buf.subarray(start, end + 1)),
    })
    if (!res.ok) throw new PublishError(`TikTok upload chunk ${start}: HTTP ${res.status}`, { retryable: res.status >= 500 })
  }
  log(`uploaded ${(size / 1e6).toFixed(1)}MB in ${Math.ceil(size / CHUNK)} chunks`)
}

export const tiktok: PlatformAdapter = {
  id: 'tiktok',
  label: 'TikTok',
  color: '#FE2C55',
  capabilities: {
    maxTextLength: 2200,
    requiresMedia: true,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: false,
    altText: false,
    image: { maxCount: 35, formats: ['jpg', 'jpeg', 'webp'], maxBytes: 20_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov', 'webm'], maxBytes: 4_000_000_000, maxDurationSec: 600 },
    options: [
      {
        key: 'privacyLevel', label: 'Privacy', type: 'select', required: true, default: 'SELF_ONLY',
        help: 'Unaudited apps can only post SELF_ONLY (private). Public posting unlocks after TikTok audit.',
        choices: [
          { value: 'SELF_ONLY', label: 'Private (only me)' },
          { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends' },
          { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' },
          { value: 'PUBLIC_TO_EVERYONE', label: 'Public' },
        ],
      },
      { key: 'title', label: 'Photo post title', type: 'text', required: false, help: 'Photo posts only. Max 90 characters.' },
      { key: 'disableComment', label: 'Disable comments', type: 'boolean', required: false, default: false },
      { key: 'disableDuet', label: 'Disable duet', type: 'boolean', required: false, default: false },
      { key: 'disableStitch', label: 'Disable stitch', type: 'boolean', required: false, default: false },
    ],
  },
  connect: {
    kind: 'oauth2',
    pkce: true,
    scopes: ['user.info.basic', 'video.publish', 'video.upload'],
    docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
  },
  caveats: [
    'Until TikTok audits your app, every post is forced to SELF_ONLY (private). This is the single biggest blocker in this dashboard -- expect a multi-week review.',
    'TikTok requires the creator to see and confirm the post settings before publish. Direct Post without that consent screen violates their terms; the composer shows the exact settings being sent.',
    'Content posted via the API is a draft-quality upload -- it does not get the editor, sounds, or effects the app offers.',
  ],

  validate({ media, options }): Issue[] {
    const issues: Issue[] = []
    const title = options.title as string | undefined
    if (title && title.length > 90) {
      issues.push({ level: 'error', field: 'options', message: `Photo title is ${title.length} characters, TikTok's limit is 90.` })
    }
    if (media.some((m) => m.kind === 'image') && media.some((m) => m.kind === 'video')) {
      issues.push({ level: 'error', field: 'media', message: 'TikTok posts are either one video or a photo set, never both.' })
    }
    if (options.privacyLevel === 'SELF_ONLY') {
      issues.push({ level: 'warning', field: 'options', message: 'Posting as private -- nobody but the account owner will see it.' })
    }
    return issues
  },

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    if (!token) throw new PublishError('TikTok account has no access token.', { reauth: true })

    const info = await creatorInfo(token)
    const requested = (ctx.options.privacyLevel as string) ?? 'SELF_ONLY'
    if (!info.privacy_level_options.includes(requested)) {
      throw new PublishError(
        `TikTok rejected privacy level "${requested}". This creator allows: ${info.privacy_level_options.join(', ')}. ` +
          `If only SELF_ONLY is listed, your app has not passed TikTok's audit yet.`,
      )
    }

    const postInfo: Record<string, unknown> = {
      privacy_level: requested,
      disable_comment: Boolean(ctx.options.disableComment) || info.comment_disabled,
    }

    const video = ctx.media.find((m) => m.kind === 'video')
    const images = ctx.media.filter((m) => m.kind === 'image')
    let publishId: string

    if (video) {
      if (video.durationMs && video.durationMs / 1000 > info.max_video_post_duration_sec) {
        throw new PublishError(
          `Video runs ${(video.durationMs / 1000).toFixed(0)}s but this creator's limit is ${info.max_video_post_duration_sec}s.`,
        )
      }
      postInfo.title = ctx.text.slice(0, 2200)
      postInfo.disable_duet = Boolean(ctx.options.disableDuet) || info.duet_disabled
      postInfo.disable_stitch = Boolean(ctx.options.disableStitch) || info.stitch_disabled

      const init = await api<{ data: { publish_id: string; upload_url: string } }>(
        `${API}/post/publish/video/init/`,
        {
          label: 'TikTok video init',
          method: 'POST',
          headers: { ...bearer(token), 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({
            post_info: postInfo,
            source_info: { source: 'FILE_UPLOAD', video_size: video.bytes, chunk_size: video.bytes, total_chunk_count: 1 },
          }),
        },
      )
      publishId = init.data.publish_id
      await uploadFile(init.data.upload_url, video.path, video.mimeType, video.bytes, ctx.log)
    } else {
      if (!images.length) throw new PublishError('TikTok needs a video or at least one photo.')
      // Photo posts pull from URLs; TikTok has no file-upload path for images.
      const urls = images.map((m) => {
        if (!m.publicUrl) {
          throw new PublishError(
            `TikTok photo posts are fetched from a public URL, but ${m.filename} has none. Set APP_URL to a public address.`,
          )
        }
        return m.publicUrl
      })
      postInfo.title = (ctx.options.title as string)?.slice(0, 90) ?? ''
      postInfo.description = ctx.text.slice(0, 2200)

      const init = await api<{ data: { publish_id: string } }>(`${API}/post/publish/content/init/`, {
        label: 'TikTok photo init',
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          post_info: postInfo,
          source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: urls },
          post_mode: 'DIRECT_POST',
          media_type: 'PHOTO',
        }),
      })
      publishId = init.data.publish_id
    }

    ctx.log(`publish id ${publishId}, waiting for TikTok to finish processing`)
    const final = await poll(
      () =>
        api<{ data: { status: string; fail_reason?: string; publicaly_available_post_id?: string[] } }>(
          `${API}/post/publish/status/fetch/`,
          {
            label: 'TikTok publish status',
            method: 'POST',
            headers: { ...bearer(token), 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ publish_id: publishId }),
          },
        ),
      (v) => {
        const s = v.data.status
        if (s === 'PUBLISH_COMPLETE') return 'done'
        if (s === 'FAILED') return { error: v.data.fail_reason ?? 'publish failed' }
        return 'wait'
      },
      { label: 'TikTok publishing', attempts: 60, intervalMs: 5000 },
    )

    const postId = final.data.publicaly_available_post_id?.[0]
    return {
      remoteId: postId ?? publishId,
      remoteUrl: postId ? `https://www.tiktok.com/@${ctx.account.handle ?? info.creator_username}/video/${postId}` : undefined,
      raw: final,
    }
  },

  async refresh(account) {
    if (!account.refreshToken) throw new PublishError('TikTok account has no refresh token; reconnect it.', { reauth: true })
    const res = await api<{ access_token: string; refresh_token: string; expires_in: number }>(
      `${API}/oauth/token/`,
      {
        label: 'TikTok token refresh',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({
          client_key: process.env.TIKTOK_CLIENT_KEY!,
          client_secret: process.env.TIKTOK_CLIENT_SECRET!,
          grant_type: 'refresh_token',
          refresh_token: account.refreshToken,
        }),
      },
    )
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
    }
  },
}
