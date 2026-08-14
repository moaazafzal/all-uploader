import { api, bearer } from '@/platforms/http'
import { GRAPH, exchangeForLongLived } from '@/platforms/meta-shared'
import type { PlatformId } from '@/platforms'
import type { RawTokens } from './exchange'

/**
 * One row per postable destination. A single Meta grant can produce several:
 * every Page the user administers, plus every IG Business account attached to
 * one of those Pages. That is why this returns an array, not an object.
 */
export interface Destination {
  externalId: string
  handle: string | null
  displayName: string | null
  avatarUrl: string | null
  /** Per-destination token. Meta Page tokens differ from the user token. */
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  meta: Record<string, unknown>
}

export async function discoverDestinations(platform: PlatformId, tokens: RawTokens): Promise<Destination[]> {
  switch (platform) {
    case 'x':
      return discoverX(tokens)
    case 'facebook':
      return discoverFacebookPages(tokens)
    case 'instagram':
      return discoverInstagram(tokens)
    case 'threads':
      return discoverThreads(tokens)
    case 'tiktok':
      return discoverTikTok(tokens)
    case 'linkedin':
      return discoverLinkedIn(tokens)
    case 'youtube':
      return discoverYouTube(tokens)
    case 'reddit':
      return discoverReddit(tokens)
    case 'pinterest':
      return discoverPinterest(tokens)
    default:
      throw new Error(`${platform} does not use OAuth discovery`)
  }
}

const base = (t: RawTokens) => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken ?? null,
  expiresAt: t.expiresAt ?? null,
})

async function discoverX(t: RawTokens): Promise<Destination[]> {
  const me = await api<{ data: { id: string; username: string; name: string; profile_image_url?: string } }>(
    'https://api.x.com/2/users/me?user.fields=profile_image_url',
    { label: 'X me', headers: bearer(t.accessToken) },
  )
  return [{
    ...base(t),
    externalId: me.data.id,
    handle: me.data.username,
    displayName: me.data.name,
    avatarUrl: me.data.profile_image_url ?? null,
    meta: {},
  }]
}

async function discoverFacebookPages(t: RawTokens): Promise<Destination[]> {
  const longLived = await exchangeForLongLived(t.accessToken)
  const pages = await api<{ data: { id: string; name: string; access_token: string; username?: string }[] }>(
    `${GRAPH}/me/accounts?fields=id,name,access_token,username&limit=100&access_token=${encodeURIComponent(longLived.accessToken)}`,
    { label: 'Facebook pages' },
  )
  // Page tokens derived from a long-lived user token do not expire.
  return pages.data.map((p) => ({
    externalId: p.id,
    handle: p.username ?? null,
    displayName: p.name,
    avatarUrl: `${GRAPH}/${p.id}/picture?type=square`,
    accessToken: p.access_token,
    refreshToken: null,
    expiresAt: null,
    meta: { pageId: p.id, userToken: longLived.accessToken },
  }))
}

async function discoverInstagram(t: RawTokens): Promise<Destination[]> {
  const longLived = await exchangeForLongLived(t.accessToken)
  const pages = await api<{
    data: { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }[]
  }>(
    `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100&access_token=${encodeURIComponent(longLived.accessToken)}`,
    { label: 'Facebook pages for Instagram' },
  )

  const out: Destination[] = []
  for (const page of pages.data) {
    const igId = page.instagram_business_account?.id
    if (!igId) continue // Page has no IG Business account attached
    const profile = await api<{ username: string; name?: string; profile_picture_url?: string }>(
      `${GRAPH}/${igId}?fields=username,name,profile_picture_url&access_token=${encodeURIComponent(page.access_token)}`,
      { label: 'Instagram profile' },
    ).catch(() => ({ username: igId, name: undefined, profile_picture_url: undefined }))

    out.push({
      externalId: igId,
      handle: profile.username,
      displayName: profile.name ?? profile.username,
      avatarUrl: profile.profile_picture_url ?? null,
      accessToken: page.access_token,
      refreshToken: null,
      expiresAt: null,
      meta: { igUserId: igId, pageId: page.id, pageName: page.name },
    })
  }
  if (!out.length) {
    throw new Error(
      'No Instagram Business account found. Convert the Instagram account to Business or Creator, ' +
        'link it to a Facebook Page you administer, then reconnect.',
    )
  }
  return out
}

async function discoverThreads(t: RawTokens): Promise<Destination[]> {
  const me = await api<{ id: string; username: string; name?: string; threads_profile_picture_url?: string }>(
    `https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url&access_token=${encodeURIComponent(t.accessToken)}`,
    { label: 'Threads me' },
  )
  return [{
    ...base(t),
    externalId: me.id,
    handle: me.username,
    displayName: me.name ?? me.username,
    avatarUrl: me.threads_profile_picture_url ?? null,
    meta: { threadsUserId: me.id },
  }]
}

async function discoverTikTok(t: RawTokens): Promise<Destination[]> {
  const me = await api<{ data: { user: { open_id: string; display_name: string; avatar_url: string; username?: string } } }>(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username',
    { label: 'TikTok user info', headers: bearer(t.accessToken) },
  )
  const u = me.data.user
  return [{
    ...base(t),
    externalId: u.open_id,
    handle: u.username ?? null,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    meta: { openId: u.open_id },
  }]
}

async function discoverLinkedIn(t: RawTokens): Promise<Destination[]> {
  const me = await api<{ sub: string; name: string; picture?: string }>('https://api.linkedin.com/v2/userinfo', {
    label: 'LinkedIn userinfo',
    headers: bearer(t.accessToken),
  })
  return [{
    ...base(t),
    externalId: me.sub,
    handle: null,
    displayName: me.name,
    avatarUrl: me.picture ?? null,
    meta: { urn: `urn:li:person:${me.sub}` },
  }]
}

async function discoverYouTube(t: RawTokens): Promise<Destination[]> {
  const res = await api<{
    items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }[]
  }>('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    label: 'YouTube channels',
    headers: bearer(t.accessToken),
  })
  if (!res.items?.length) throw new Error('This Google account has no YouTube channel.')
  return res.items.map((c) => ({
    ...base(t),
    externalId: c.id,
    handle: c.snippet.customUrl ?? null,
    displayName: c.snippet.title,
    avatarUrl: c.snippet.thumbnails?.default?.url ?? null,
    meta: { channelId: c.id },
  }))
}

async function discoverReddit(t: RawTokens): Promise<Destination[]> {
  const me = await api<{ id: string; name: string; icon_img?: string }>('https://oauth.reddit.com/api/v1/me', {
    label: 'Reddit me',
    headers: { ...bearer(t.accessToken), 'User-Agent': process.env.REDDIT_USER_AGENT ?? 'all-uploader/1.0' },
  })
  return [{
    ...base(t),
    externalId: me.id,
    handle: me.name,
    displayName: `u/${me.name}`,
    avatarUrl: me.icon_img?.split('?')[0] ?? null,
    meta: {},
  }]
}

async function discoverPinterest(t: RawTokens): Promise<Destination[]> {
  const me = await api<{ id: string; username: string; profile_image?: string }>(
    'https://api.pinterest.com/v5/user_account',
    { label: 'Pinterest account', headers: bearer(t.accessToken) },
  )
  // Boards are needed at post time; cache them so the composer can offer a picker.
  const boards = await api<{ items: { id: string; name: string }[] }>(
    'https://api.pinterest.com/v5/boards?page_size=100',
    { label: 'Pinterest boards', headers: bearer(t.accessToken) },
  ).catch(() => ({ items: [] }))

  return [{
    ...base(t),
    externalId: me.id,
    handle: me.username,
    displayName: me.username,
    avatarUrl: me.profile_image ?? null,
    meta: { boards: boards.items },
  }]
}
