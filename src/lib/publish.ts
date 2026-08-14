import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets, postMedia, postTargets, posts, socialAccounts } from '@/db/schema'
import { getAdapter, validateForAdapter, PublishError } from '@/platforms'
import type { Issue, ResolvedMedia } from '@/platforms/types'
import { getUsableAccount, markNeedsReauth } from './accounts'
import { pathFor, publicUrlFor } from './storage'
import { enqueue } from './queue'

/** Load a post's media in composer order, shaped for the adapters. */
export async function resolveMedia(postId: string): Promise<ResolvedMedia[]> {
  const rows = await db
    .select({ media: mediaAssets, position: postMedia.position })
    .from(postMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, postMedia.mediaId))
    .where(eq(postMedia.postId, postId))
    .orderBy(asc(postMedia.position))

  return rows.map(({ media }) => ({
    id: media.id,
    kind: media.kind,
    filename: media.filename,
    mimeType: media.mimeType,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    path: pathFor(media.storageKey),
    publicUrl: publicUrlFor(media.id),
  }))
}

export interface TargetPreflight {
  targetId: string
  platform: string
  accountLabel: string
  issues: Issue[]
}

/**
 * Validate every destination before anything is sent. The composer calls this
 * so a 400-character body is caught while it is still editable, rather than
 * after it has already gone live on three other platforms.
 */
export async function preflight(postId: string): Promise<TargetPreflight[]> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1)
  if (!post) throw new Error('Post not found')

  const targets = await db
    .select({ target: postTargets, account: socialAccounts })
    .from(postTargets)
    .innerJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
    .where(eq(postTargets.postId, postId))

  const media = await resolveMedia(postId)

  return targets.map(({ target, account }) => {
    const adapter = getAdapter(target.platform)
    const issues = validateForAdapter(adapter, {
      text: target.overrideText ?? post.text,
      media,
      options: target.options,
    })
    if (account.status === 'needs_reauth') {
      issues.push({ level: 'error', field: 'account', message: `${adapter.label} needs to be reconnected.` })
    }
    return {
      targetId: target.id,
      platform: target.platform,
      accountLabel: account.handle ?? account.displayName ?? account.externalId,
      issues,
    }
  })
}

/**
 * Fan out one job per target. Separate jobs on purpose: a TikTok transcode that
 * takes four minutes must not hold up the X post, and a failure retries only
 * its own destination.
 */
export async function schedulePost(postId: string, runAt?: Date) {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1)
  if (!post) throw new Error('Post not found')

  const checks = await preflight(postId)
  const blocking = checks.filter((c) => c.issues.some((i) => i.level === 'error'))
  if (blocking.length) {
    const detail = blocking
      .map((b) => `${b.platform} (${b.accountLabel}): ${b.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ')}`)
      .join(' | ')
    throw new PublishError(`Cannot publish yet -- ${detail}`)
  }

  const when = runAt ?? post.scheduledAt ?? new Date()
  const targets = await db.select().from(postTargets).where(
    and(eq(postTargets.postId, postId), inArray(postTargets.status, ['pending', 'failed'])),
  )
  if (!targets.length) throw new Error('This post has no destinations left to publish to.')

  await db
    .update(posts)
    .set({ status: when > new Date() ? 'scheduled' : 'publishing', scheduledAt: when, updatedAt: new Date() })
    .where(eq(posts.id, postId))

  for (const t of targets) {
    await db.update(postTargets).set({ status: 'pending', error: null }).where(eq(postTargets.id, t.id))
    await enqueue({
      kind: 'publish_target',
      payload: { targetId: t.id },
      runAt: when,
      // One live job per target, no matter how often publish is clicked.
      dedupeKey: `publish_target:${t.id}`,
    })
  }
  return targets.length
}

/** Publish exactly one destination. Called by the worker, one job per target. */
export async function publishTarget(targetId: string, log: (m: string) => void) {
  const [row] = await db
    .select({ target: postTargets, post: posts })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(eq(postTargets.id, targetId))
    .limit(1)
  if (!row) throw new PublishError(`Target ${targetId} no longer exists.`)

  const { target, post } = row
  if (target.status === 'published') {
    log('already published, skipping')
    return
  }
  if (post.status === 'cancelled') {
    await db.update(postTargets).set({ status: 'skipped' }).where(eq(postTargets.id, targetId))
    return
  }

  await db
    .update(postTargets)
    .set({ status: 'publishing', lastAttemptAt: new Date(), attempts: target.attempts + 1 })
    .where(eq(postTargets.id, targetId))

  const adapter = getAdapter(target.platform)

  try {
    const account = await getUsableAccount(target.socialAccountId)
    const media = await resolveMedia(post.id)
    const text = target.overrideText ?? post.text

    const issues = validateForAdapter(adapter, { text, media, options: target.options })
    const errors = issues.filter((i) => i.level === 'error')
    if (errors.length) {
      // A content problem will never fix itself; do not burn retries on it.
      throw new PublishError(errors.map((e) => e.message).join(' '), { retryable: false })
    }

    const result = await adapter.publish({
      account,
      text,
      media,
      // Stable key so a retry after a timeout does not double-post where the
      // platform supports idempotency.
      options: { ...target.options, __idempotencyKey: `${target.id}` },
      log,
    })

    await db
      .update(postTargets)
      .set({
        status: 'published',
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl ?? null,
        error: null,
        publishedAt: new Date(),
      })
      .where(eq(postTargets.id, targetId))
    log(`published as ${result.remoteId}`)
  } catch (err) {
    const e = err as PublishError
    const retryable = e instanceof PublishError ? e.retryable : false
    if (e instanceof PublishError && e.reauth) {
      await markNeedsReauth(target.socialAccountId, e.message)
    }
    await db
      .update(postTargets)
      .set({ status: retryable ? 'pending' : 'failed', error: e.message.slice(0, 2000) })
      .where(eq(postTargets.id, targetId))
    throw err
  } finally {
    await rollUpPostStatus(post.id)
  }
}

/**
 * The post's status is derived from its targets. "partial" is a first-class
 * outcome: some platforms took it, some did not, and the user needs to see
 * exactly which without digging.
 */
export async function rollUpPostStatus(postId: string) {
  const targets = await db.select().from(postTargets).where(eq(postTargets.postId, postId))
  if (!targets.length) return

  const done = targets.filter((t) => t.status === 'published').length
  const failed = targets.filter((t) => t.status === 'failed').length
  const settled = done + failed + targets.filter((t) => t.status === 'skipped').length

  let status: typeof posts.$inferSelect.status
  if (settled < targets.length) status = 'publishing'
  else if (failed === 0) status = 'published'
  else if (done === 0) status = 'failed'
  else status = 'partial'

  await db
    .update(posts)
    .set({
      status,
      publishedAt: status === 'published' || status === 'partial' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId))
}

/** Retry only the destinations that failed, leaving successful ones untouched. */
export async function retryFailedTargets(postId: string) {
  const failed = await db
    .select()
    .from(postTargets)
    .where(and(eq(postTargets.postId, postId), eq(postTargets.status, 'failed')))
  for (const t of failed) {
    await db.update(postTargets).set({ status: 'pending', error: null }).where(eq(postTargets.id, t.id))
    await enqueue({ kind: 'publish_target', payload: { targetId: t.id }, dedupeKey: `publish_target:${t.id}` })
  }
  if (failed.length) await db.update(posts).set({ status: 'publishing' }).where(eq(posts.id, postId))
  return failed.length
}
