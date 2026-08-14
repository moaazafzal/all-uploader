import crypto from 'node:crypto'
import type { PlatformId } from '@/platforms'

export interface OAuthProvider {
  authorizeUrl: string
  tokenUrl: string
  clientId: () => string | undefined
  clientSecret: () => string | undefined
  scopes: string[]
  /** Some providers need the secret in a Basic header rather than the body. */
  tokenAuth: 'body' | 'basic'
  pkce: boolean
  /** Extra params on the authorize redirect. */
  extraAuthParams?: Record<string, string>
  scopeSeparator?: string
}

/**
 * Note that Threads is NOT on the Facebook host despite being a Meta product,
 * and TikTok uses client_key rather than client_id -- handled in exchange().
 */
export const OAUTH_PROVIDERS: Partial<Record<PlatformId, OAuthProvider>> = {
  x: {
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    clientId: () => process.env.X_CLIENT_ID,
    clientSecret: () => process.env.X_CLIENT_SECRET,
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
    tokenAuth: 'basic',
    pkce: true,
  },
  facebook: {
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    clientId: () => process.env.META_APP_ID,
    clientSecret: () => process.env.META_APP_SECRET,
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management'],
    tokenAuth: 'body',
    pkce: false,
    scopeSeparator: ',',
  },
  instagram: {
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    clientId: () => process.env.META_APP_ID,
    clientSecret: () => process.env.META_APP_SECRET,
    scopes: [
      'instagram_basic', 'instagram_content_publish',
      'pages_show_list', 'pages_read_engagement', 'business_management',
    ],
    tokenAuth: 'body',
    pkce: false,
    scopeSeparator: ',',
  },
  threads: {
    authorizeUrl: 'https://threads.net/oauth/authorize',
    tokenUrl: 'https://graph.threads.net/oauth/access_token',
    clientId: () => process.env.THREADS_APP_ID,
    clientSecret: () => process.env.THREADS_APP_SECRET,
    scopes: ['threads_basic', 'threads_content_publish'],
    tokenAuth: 'body',
    pkce: false,
    scopeSeparator: ',',
  },
  tiktok: {
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    clientId: () => process.env.TIKTOK_CLIENT_KEY,
    clientSecret: () => process.env.TIKTOK_CLIENT_SECRET,
    scopes: ['user.info.basic', 'video.publish', 'video.upload'],
    tokenAuth: 'body',
    pkce: true,
  },
  linkedin: {
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    clientId: () => process.env.LINKEDIN_CLIENT_ID,
    clientSecret: () => process.env.LINKEDIN_CLIENT_SECRET,
    scopes: ['openid', 'profile', 'w_member_social'],
    tokenAuth: 'body',
    pkce: false,
  },
  youtube: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
    tokenAuth: 'body',
    pkce: false,
    // Google only returns a refresh token on the first consent unless forced.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  reddit: {
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    clientId: () => process.env.REDDIT_CLIENT_ID,
    clientSecret: () => process.env.REDDIT_CLIENT_SECRET,
    scopes: ['identity', 'submit', 'flair'],
    tokenAuth: 'basic',
    pkce: false,
    extraAuthParams: { duration: 'permanent' },
  },
  pinterest: {
    authorizeUrl: 'https://www.pinterest.com/oauth/',
    tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
    clientId: () => process.env.PINTEREST_APP_ID,
    clientSecret: () => process.env.PINTEREST_APP_SECRET,
    scopes: ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'],
    tokenAuth: 'basic',
    pkce: false,
  },
}

export const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
export const redirectUri = (platform: string) => `${appUrl()}/api/oauth/${platform}/callback`

export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Which platforms have credentials configured -- drives the connect screen. */
export function isConfigured(platform: PlatformId): boolean {
  const p = OAUTH_PROVIDERS[platform]
  if (!p) return true // credential/token platforms need no app registration
  return Boolean(p.clientId() && p.clientSecret())
}
