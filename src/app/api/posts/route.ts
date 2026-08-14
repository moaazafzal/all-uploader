import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets, postMedia, postTargets, posts, socialAccounts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { bad, handle } from '@/lib/api'

export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url)
    const workspaceId = url.searchParams.get('workspace')
    if (!workspaceId) throw bad('workspace is required')
    await requireMembership(workspaceId)

    const rows = await db
      .select()
      .from(posts)
      .where(eq(posts.workspaceId, workspaceId))
      .orderBy(desc(posts.createdAt))
      .limit(Number(url.searchParams.get('limit') ?? 50))

    if (!rows.length) return []
    const ids = rows.map((r) => r.id)

    const targets = await db
      .select({ target: postTargets, account: socialAccounts })
      .from(postTargets)
      .innerJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
      .where(inArray(postTargets.postId, ids))

    const media = await db
      .select({ postId: postMedia.postId, media: mediaAssets, position: postMedia.position })
      .from(postMedia)
      .innerJoin(mediaAssets, eq(mediaAssets.id, postMedia.mediaId))
      .where(inArray(postMedia.postId, ids))

    return rows.map((p) => ({
      ...p,
      targets: targets
        .filter((t) => t.target.postId === p.id)
        .map(({ target, account }) => ({
          ...target,
          accountHandle: account.handle ?? account.displayName,
          accountAvatar: account.avatarUrl,
        })),
      media: media.filter((m) => m.postId === p.id).sort((a, b) => a.position - b.position).map((m) => m.media),
    }))
  })
}

export async function POST(req: Request) {
  return handle(async () => {
    const { workspaceId, text, mediaIds, targets, scheduledAt } = await req.json()
    if (!workspaceId) throw bad('workspaceId is required')
    const { user } = await requireMembership(workspaceId)
    if (!Array.isArray(targets) || !targets.length) throw bad('Pick at least one account to post to.')

    // Every referenced account must belong to this workspace.
    const accountIds = targets.map((t: { accountId: string }) => t.accountId)
    const accounts = await db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.workspaceId, workspaceId), inArray(socialAccounts.id, accountIds)))
    if (accounts.length !== accountIds.length) throw bad('One of those accounts is not in this workspace.')

    const [post] = await db
      .insert(posts)
      .values({
        workspaceId,
        authorId: user.id,
        text: text ?? '',
        status: 'draft',
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      })
      .returning()

    if (Array.isArray(mediaIds) && mediaIds.length) {
      const owned = await db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.workspaceId, workspaceId), inArray(mediaAssets.id, mediaIds)))
      if (owned.length !== mediaIds.length) throw bad('One of those files is not in this workspace.')
      await db.insert(postMedia).values(
        mediaIds.map((id: string, i: number) => ({ postId: post.id, mediaId: id, position: i })),
      )
    }

    await db.insert(postTargets).values(
      targets.map((t: { accountId: string; overrideText?: string; options?: Record<string, unknown> }) => {
        const account = accounts.find((a) => a.id === t.accountId)!
        return {
          postId: post.id,
          socialAccountId: t.accountId,
          platform: account.platform,
          overrideText: t.overrideText ?? null,
          options: t.options ?? {},
        }
      }),
    )

    return post
  })
}
