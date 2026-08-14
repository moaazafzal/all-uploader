import { NextResponse } from 'next/server'
import { and, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import { auditLog, oauthStates } from '@/db/schema'
import { exchangeCode } from '@/lib/oauth/exchange'
import { discoverDestinations } from '@/lib/oauth/discover'
import { saveAccount } from '@/lib/accounts'
import { appUrl } from '@/lib/oauth/providers'
import type { PlatformId } from '@/platforms'

export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')

  if (error) return fail(platform, error)
  if (!code || !state) return fail(platform, 'The provider returned no authorization code.')

  const [row] = await db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, state), gt(oauthStates.expiresAt, new Date())))
    .limit(1)
  if (!row) return fail(platform, 'This connection link expired or was already used. Start again.')

  // One-shot: burn the state whatever happens next.
  await db.delete(oauthStates).where(eq(oauthStates.state, state))
  if (row.platform !== platform) return fail(platform, 'State does not match this platform.')

  try {
    const tokens = await exchangeCode(platform as PlatformId, code, row.codeVerifier)
    const destinations = await discoverDestinations(platform as PlatformId, tokens)

    for (const d of destinations) {
      await saveAccount({
        workspaceId: row.workspaceId,
        platform,
        externalId: d.externalId,
        handle: d.handle,
        displayName: d.displayName,
        avatarUrl: d.avatarUrl,
        accessToken: d.accessToken,
        refreshToken: d.refreshToken ?? null,
        tokenExpiresAt: d.expiresAt ?? null,
        scopes: tokens.scopes,
        meta: d.meta,
        connectedByUserId: row.userId,
      })
    }

    await db.insert(auditLog).values({
      workspaceId: row.workspaceId,
      userId: row.userId,
      action: 'account.connected',
      subject: platform,
      detail: { count: destinations.length, handles: destinations.map((d) => d.handle) },
    })

    const to = new URL(row.redirectTo ?? '/accounts', appUrl())
    to.searchParams.set('connected', platform)
    to.searchParams.set('count', String(destinations.length))
    return NextResponse.redirect(to)
  } catch (err) {
    return fail(platform, (err as Error).message)
  }
}

function fail(platform: string, message: string) {
  const to = new URL('/accounts', appUrl())
  to.searchParams.set('error', `${platform}: ${message}`)
  return NextResponse.redirect(to)
}
