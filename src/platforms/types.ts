import type { SocialAccount } from '@/db/schema'

export const PLATFORM_IDS = [
  'x', 'bluesky', 'mastodon', 'telegram', 'discord',
  'facebook', 'instagram', 'threads',
  'tiktok', 'linkedin', 'youtube', 'reddit', 'pinterest',
] as const

export type PlatformId = (typeof PLATFORM_IDS)[number]

/* -------------------------------------------------------------- capability */

export interface MediaSpec {
  maxCount: number
  /** Lowercase extensions the platform accepts. */
  formats: string[]
  maxBytes: number
  minDurationSec?: number
  maxDurationSec?: number
  /** [min, max] width/height ratio. A 1:1 square is 1.0. */
  aspectRatio?: [number, number]
  minWidth?: number
  minHeight?: number
}

export interface Capabilities {
  maxTextLength: number
  /** Post cannot be text-only (Instagram, TikTok, YouTube, Pinterest). */
  requiresMedia: boolean
  /** Post can be media-only with empty text. */
  textOptional: boolean
  /** Images and video in the same post. Almost nowhere allows this. */
  mixedMedia: boolean
  image?: MediaSpec
  video?: MediaSpec
  /** Platform itself can hold a future-dated post; otherwise we schedule locally. */
  nativeScheduling: boolean
  altText: boolean
  /** Extra required/optional fields the composer must collect (subreddit, board, title...). */
  options?: OptionField[]
}

export interface OptionField {
  key: string
  label: string
  type: 'text' | 'select' | 'boolean'
  required: boolean
  choices?: { value: string; label: string }[]
  help?: string
  default?: string | boolean
}

/* ------------------------------------------------------------- connection */

export type ConnectStrategy =
  /** Standard OAuth2 redirect (optionally PKCE). */
  | { kind: 'oauth2'; pkce: boolean; scopes: string[]; docsUrl: string }
  /** User supplies credentials directly -- Bluesky app password, Mastodon instance + token. */
  | { kind: 'credentials'; fields: OptionField[]; docsUrl: string }
  /** User pastes a webhook URL / bot token -- Discord, Telegram. */
  | { kind: 'token'; fields: OptionField[]; docsUrl: string }

/* -------------------------------------------------------------- publishing */

export interface ResolvedMedia {
  id: string
  kind: 'image' | 'video'
  filename: string
  mimeType: string
  bytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  /** Absolute path on the worker's disk. */
  path: string
  /** Publicly reachable URL. Required by Instagram/Threads/Pinterest, which pull media rather than accept an upload. */
  publicUrl: string | null
  altText?: string | null
}

export interface PublishContext {
  account: DecryptedAccount
  text: string
  media: ResolvedMedia[]
  options: Record<string, unknown>
  log: (message: string) => void
}

export interface DecryptedAccount extends Omit<SocialAccount, 'accessToken' | 'refreshToken'> {
  accessToken: string | null
  refreshToken: string | null
}

export interface PublishResult {
  remoteId: string
  remoteUrl?: string
  raw?: unknown
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  scopes?: string[]
}

/* -------------------------------------------------------------- validation */

export interface Issue {
  level: 'error' | 'warning'
  message: string
  /** Surfaced next to the offending field in the composer. */
  field?: 'text' | 'media' | 'options' | 'account'
}

/**
 * Thrown by adapters to distinguish "this will never work, stop retrying" from
 * "the network hiccuped". The worker only retries when `retryable` is true, and
 * flips the account to needs_reauth when `reauth` is set.
 */
export class PublishError extends Error {
  retryable: boolean
  reauth: boolean
  status?: number
  constructor(message: string, opts: { retryable?: boolean; reauth?: boolean; status?: number } = {}) {
    super(message)
    this.name = 'PublishError'
    this.retryable = opts.retryable ?? false
    this.reauth = opts.reauth ?? false
    this.status = opts.status
  }
}

/* ----------------------------------------------------------------- adapter */

export interface PlatformAdapter {
  id: PlatformId
  label: string
  /** Brand hex, used for chips and the account list. */
  color: string
  capabilities: Capabilities
  connect: ConnectStrategy

  /** Extra checks beyond the generic capability engine. Runs in the composer AND before publish. */
  validate?(ctx: Omit<PublishContext, 'log' | 'account'> & { account?: DecryptedAccount }): Issue[]

  publish(ctx: PublishContext): Promise<PublishResult>

  /** Called when the stored token is within the refresh window. */
  refresh?(account: DecryptedAccount): Promise<TokenSet>

  /**
   * Practical gotchas shown in the UI when connecting -- app review needed,
   * quota limits, account-type requirements. Honest friction, up front.
   */
  caveats?: string[]
}
