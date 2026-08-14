import fs from 'node:fs/promises'
import { api, bearer, form } from './http'
import { PublishError, type PlatformAdapter, type PublishContext } from './types'

const API = 'https://oauth.reddit.com'
const ua = () => process.env.REDDIT_USER_AGENT ?? 'all-uploader/1.0'

/** Reddit media goes to S3 via a pre-signed lease, then the asset URL is submitted. */
async function uploadMedia(token: string, m: { path: string; filename: string; mimeType: string }): Promise<string> {
  const lease = await api<{ args: { action: string; fields: { name: string; value: string }[] }; asset: { asset_id: string } }>(
    `${API}/api/media/asset.json`,
    {
      label: 'Reddit media lease',
      method: 'POST',
      headers: { ...bearer(token), 'User-Agent': ua(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ filepath: m.filename, mimetype: m.mimeType }),
    },
  )

  const body = new FormData()
  for (const f of lease.args.fields) body.set(f.name, f.value)
  body.set('file', new Blob([await fs.readFile(m.path)], { type: m.mimeType }), m.filename)

  const action = lease.args.action.startsWith('//') ? `https:${lease.args.action}` : lease.args.action
  const res = await fetch(action, { method: 'POST', body })
  if (!res.ok) throw new PublishError(`Reddit media upload: HTTP ${res.status}`, { retryable: res.status >= 500 })

  const key = lease.args.fields.find((f) => f.name === 'key')?.value
  return `${action.replace(/\/$/, '')}/${key}`
}

export const reddit: PlatformAdapter = {
  id: 'reddit',
  label: 'Reddit',
  color: '#FF4500',
  capabilities: {
    maxTextLength: 40_000, // selftext; title is capped separately at 300
    requiresMedia: false,
    textOptional: true,
    mixedMedia: false,
    nativeScheduling: false,
    altText: false,
    image: { maxCount: 20, formats: ['jpg', 'jpeg', 'png', 'gif'], maxBytes: 20_000_000 },
    video: { maxCount: 1, formats: ['mp4', 'mov'], maxBytes: 1_000_000_000, maxDurationSec: 900 },
    options: [
      { key: 'subreddit', label: 'Subreddit', type: 'text', required: true, help: 'Without the r/ prefix.' },
      { key: 'title', label: 'Title', type: 'text', required: true, help: 'Max 300 characters.' },
      { key: 'flairId', label: 'Flair ID', type: 'text', required: false, help: 'Some subreddits reject posts with no flair.' },
      { key: 'nsfw', label: 'Mark NSFW', type: 'boolean', required: false, default: false },
    ],
  },
  connect: {
    kind: 'oauth2',
    pkce: false,
    scopes: ['identity', 'submit', 'flair'],
    docsUrl: 'https://www.reddit.com/prefs/apps',
  },
  caveats: [
    'Every subreddit has its own rules, karma gates and posting cooldowns. A technically valid API call still gets removed by AutoModerator.',
    'Reddit rate-limits posting hard for new or low-karma accounts.',
  ],

  async publish(ctx: PublishContext) {
    const token = ctx.account.accessToken
    if (!token) throw new PublishError('Reddit account has no access token.', { reauth: true })
    const sr = String(ctx.options.subreddit ?? '').replace(/^\/?r\//, '')
    const title = String(ctx.options.title ?? '').slice(0, 300)
    if (!sr || !title) throw new PublishError('Reddit needs a subreddit and a title.')

    const payload: Record<string, string | boolean | undefined> = {
      sr,
      title,
      api_type: 'json',
      nsfw: Boolean(ctx.options.nsfw),
      flair_id: ctx.options.flairId as string | undefined,
    }

    const video = ctx.media.find((m) => m.kind === 'video')
    const images = ctx.media.filter((m) => m.kind === 'image')

    if (video) {
      payload.kind = 'video'
      payload.url = await uploadMedia(token, video)
      ctx.log('uploaded video to Reddit media store')
    } else if (images.length === 1) {
      payload.kind = 'image'
      payload.url = await uploadMedia(token, images[0])
    } else if (images.length > 1) {
      payload.kind = 'self'
      const urls: string[] = []
      for (const img of images) urls.push(await uploadMedia(token, img))
      payload.items = JSON.stringify(urls.map((u) => ({ media_id: u })))
      payload.kind = 'gallery'
    } else {
      payload.kind = 'self'
      payload.text = ctx.text
    }

    const res = await api<{ json: { errors: string[][]; data?: { id: string; url: string } } }>(
      `${API}/api/submit`,
      {
        label: 'Reddit submit',
        method: 'POST',
        headers: { ...bearer(token), 'User-Agent': ua(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form(payload as Record<string, string>),
      },
    )
    // Reddit answers 200 with an errors array rather than an HTTP error status.
    if (res.json.errors?.length) {
      throw new PublishError(`Reddit rejected the post: ${res.json.errors.map((e) => e.join(' ')).join('; ')}`)
    }
    return { remoteId: res.json.data?.id ?? '', remoteUrl: res.json.data?.url, raw: res }
  },

  async refresh(account) {
    if (!account.refreshToken) throw new PublishError('Reddit account has no refresh token; reconnect it.', { reauth: true })
    const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64')
    const res = await api<{ access_token: string; expires_in: number }>('https://www.reddit.com/api/v1/access_token', {
      label: 'Reddit token refresh',
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'User-Agent': ua(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form({ grant_type: 'refresh_token', refresh_token: account.refreshToken }),
    })
    return {
      accessToken: res.access_token,
      refreshToken: account.refreshToken,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
    }
  },
}
