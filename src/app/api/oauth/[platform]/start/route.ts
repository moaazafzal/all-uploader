import { NextResponse } from 'next/server'
import { db } from '@/db'
import { oauthStates } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { randomToken } from '@/lib/crypto'
import { buildAuthorizeUrl } from '@/lib/oauth/exchange'
import { OAUTH_PROVIDERS, isConfigured, pkcePair } from '@/lib/oauth/providers'
import type { PlatformId } from '@/platforms'

export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params
  const url = new URL(req.url)
  const workspaceId = url.searchParams.get('workspace')
  if (!workspaceId) return NextResponse.json({ error: 'workspace is required' }, { status: 400 })

  const provider = OAUTH_PROVIDERS[platform as PlatformId]
  if (!provider) return NextResponse.json({ error: `${platform} does not use OAuth` }, { status: 400 })
  if (!isConfigured(platform as PlatformId)) {
    return NextResponse.json(
      { error: `${platform} has no client credentials configured. Set them in .env and restart.` },
      { status: 400 },
    )
  }

  const { user } = await requireMembership(workspaceId, 'admin')

  // state ties the callback back to this user+workspace and blocks CSRF.
  const state = randomToken(24)
  const pkce = provider.pkce ? pkcePair() : null
  await db.insert(oauthStates).values({
    state,
    workspaceId,
    userId: user.id,
    platform,
    codeVerifier: pkce?.verifier ?? null,
    redirectTo: url.searchParams.get('redirectTo') ?? '/accounts',
    expiresAt: new Date(Date.now() + 15 * 60_000),
  })

  return NextResponse.redirect(buildAuthorizeUrl(platform as PlatformId, state, pkce?.challenge))
}
