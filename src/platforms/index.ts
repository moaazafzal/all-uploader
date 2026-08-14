import type { PlatformAdapter, PlatformId } from './types'
import { x } from './x'
import { bluesky } from './bluesky'
import { mastodon } from './mastodon'
import { telegram } from './telegram'
import { discord } from './discord'
import { facebook } from './facebook'
import { instagram } from './instagram'
import { threads } from './threads'
import { tiktok } from './tiktok'
import { linkedin } from './linkedin'
import { youtube } from './youtube'
import { reddit } from './reddit'
import { pinterest } from './pinterest'

export const adapters = {
  x, bluesky, mastodon, telegram, discord,
  facebook, instagram, threads,
  tiktok, linkedin, youtube, reddit, pinterest,
} satisfies Record<PlatformId, PlatformAdapter>

export function getAdapter(id: string): PlatformAdapter {
  const a = adapters[id as PlatformId]
  if (!a) throw new Error(`Unknown platform: ${id}`)
  return a
}

/**
 * Setup difficulty, shown in the connect screen. This is the honest part of the
 * product: "connect everything" is easy to promise and gated by other people's
 * review queues in practice.
 */
export const SETUP_TIER: Record<PlatformId, { tier: 'instant' | 'app' | 'review'; note: string }> = {
  bluesky:   { tier: 'instant', note: 'App password in your own settings. Works immediately.' },
  mastodon:  { tier: 'instant', note: 'Access token from your instance. Works immediately.' },
  telegram:  { tier: 'instant', note: 'Bot token from @BotFather. Works immediately.' },
  discord:   { tier: 'instant', note: 'Channel webhook URL. Works immediately.' },
  x:         { tier: 'app',     note: 'Free developer app. 500 posts/month on the free tier.' },
  reddit:    { tier: 'app',     note: 'Self-serve app registration. Subreddit rules still apply.' },
  linkedin:  { tier: 'review',  note: 'w_member_social needs LinkedIn approval. Company Pages need a partner program.' },
  youtube:   { tier: 'review',  note: 'Works at ~6 uploads/day immediately; more needs a quota increase review.' },
  pinterest: { tier: 'review',  note: 'Trial mode works on your own account; standard access needs review.' },
  facebook:  { tier: 'review',  note: 'Meta App Review for pages_manage_posts.' },
  instagram: { tier: 'review',  note: 'Meta App Review plus an IG Business account. Needs a public APP_URL.' },
  threads:   { tier: 'review',  note: 'Meta App Review. Separate OAuth from Facebook. Needs a public APP_URL.' },
  tiktok:    { tier: 'review',  note: 'Posts are forced private until TikTok audits your app. Slowest approval in the set.' },
}

export type { PlatformAdapter, PlatformId }
export * from './types'
export { validateForAdapter, checkCapabilities } from './validate'
