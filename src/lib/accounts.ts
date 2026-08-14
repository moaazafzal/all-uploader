import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { socialAccounts } from '@/db/schema'
import { decryptOrNull, encryptOrNull } from './crypto'
import { getAdapter } from '@/platforms'
import type { SocialAccount } from '@/db/schema'
import type { DecryptedAccount } from '@/platforms/types'

/** Refresh this far ahead of expiry so a long upload does not die mid-flight. */
const REFRESH_WINDOW_MS = 10 * 60 * 1000

export function decryptAccount(row: SocialAccount): DecryptedAccount {
  return {
    ...row,
    accessToken: decryptOrNull(row.accessToken),
    refreshToken: decryptOrNull(row.refreshToken),
  }
}

/**
 * Returns an account with a token that is valid right now, refreshing first if
 * it is close to expiry. Adapters therefore never deal with refresh logic.
 */
export async function getUsableAccount(accountId: string): Promise<DecryptedAccount> {
  const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1)
  if (!row) throw new Error(`Connected account ${accountId} no longer exists.`)
  if (row.status === 'disabled') throw new Error(`Account ${row.handle ?? row.externalId} is disabled.`)

  const account = decryptAccount(row)
  const expiresSoon = row.tokenExpiresAt && row.tokenExpiresAt.getTime() - Date.now() < REFRESH_WINDOW_MS
  if (!expiresSoon) return account

  const adapter = getAdapter(row.platform)
  if (!adapter.refresh) {
    // Nothing we can do but tell the user to reconnect.
    await markNeedsReauth(row.id, 'Token expired and this platform has no refresh flow.')
    throw new Error(`${adapter.label} token expired -- reconnect the account.`)
  }

  try {
    const fresh = await adapter.refresh(account)
    const [updated] = await db
      .update(socialAccounts)
      .set({
        accessToken: encryptOrNull(fresh.accessToken),
        refreshToken: encryptOrNull(fresh.refreshToken ?? account.refreshToken),
        tokenExpiresAt: fresh.expiresAt ?? null,
        status: 'active',
        lastError: null,
      })
      .where(eq(socialAccounts.id, row.id))
      .returning()
    return decryptAccount(updated)
  } catch (err) {
    await markNeedsReauth(row.id, (err as Error).message)
    throw new Error(`${adapter.label} token refresh failed: ${(err as Error).message}`)
  }
}

export async function markNeedsReauth(accountId: string, reason: string) {
  await db
    .update(socialAccounts)
    .set({ status: 'needs_reauth', lastError: reason.slice(0, 1000) })
    .where(eq(socialAccounts.id, accountId))
}

export async function clearError(accountId: string) {
  await db
    .update(socialAccounts)
    .set({ status: 'active', lastError: null })
    .where(eq(socialAccounts.id, accountId))
}

/** Upsert on (workspace, platform, externalId) so reconnecting refreshes in place. */
export async function saveAccount(input: {
  workspaceId: string
  platform: string
  externalId: string
  handle: string | null
  displayName: string | null
  avatarUrl: string | null
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: Date | null
  scopes?: string[]
  meta: Record<string, unknown>
  connectedByUserId: string
}) {
  const values = {
    ...input,
    accessToken: encryptOrNull(input.accessToken),
    refreshToken: encryptOrNull(input.refreshToken),
    scopes: input.scopes ?? null,
    status: 'active' as const,
    lastError: null,
  }
  const [row] = await db
    .insert(socialAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [socialAccounts.workspaceId, socialAccounts.platform, socialAccounts.externalId],
      set: {
        handle: values.handle,
        displayName: values.displayName,
        avatarUrl: values.avatarUrl,
        accessToken: values.accessToken,
        refreshToken: values.refreshToken,
        tokenExpiresAt: values.tokenExpiresAt,
        scopes: values.scopes,
        meta: values.meta,
        status: 'active',
        lastError: null,
      },
    })
    .returning()
  return row
}

/** Safe projection for the browser -- never leaks tokens. */
export function publicAccount(row: SocialAccount) {
  return {
    id: row.id,
    platform: row.platform,
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    status: row.status,
    lastError: row.lastError,
    tokenExpiresAt: row.tokenExpiresAt,
    meta: scrubMeta(row.meta),
  }
}

/** meta holds a Meta user token for page re-derivation; that must not ship to the client. */
function scrubMeta(meta: Record<string, unknown>) {
  const { userToken, botToken, webhookUrl, ...safe } = meta as Record<string, unknown>
  return safe
}
