import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { postTargets, posts, socialAccounts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { resolveMedia } from '@/lib/publish'
import { bad, handle } from '@/lib/api'

async function load(id: string) {
  const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  if (!post) throw bad('Post not found', 404)
  return post
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const post = await load(id)
    await requireMembership(post.workspaceId)
    const targets = await db
      .select({ target: postTargets, account: socialAccounts })
      .from(postTargets)
      .innerJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
      .where(eq(postTargets.postId, id))
    return {
      ...post,
      media: await resolveMedia(id),
      targets: targets.map(({ target, account }) => ({
        ...target,
        accountHandle: account.handle ?? account.displayName,
        accountAvatar: account.avatarUrl,
        accountStatus: account.status,
      })),
    }
  })
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const post = await load(id)
    await requireMembership(post.workspaceId)
    if (post.status === 'published' || post.status === 'publishing') {
      throw bad('This post is already out; edit it on the platform itself.')
    }
    const body = await req.json()
    const [updated] = await db
      .update(posts)
      .set({
        text: body.text ?? post.text,
        scheduledAt: body.scheduledAt === undefined ? post.scheduledAt : body.scheduledAt ? new Date(body.scheduledAt) : null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, id))
      .returning()
    return updated
  })
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const post = await load(id)
    await requireMembership(post.workspaceId)
    // Cancelling rather than deleting keeps the record of what already went out.
    if (post.status === 'published' || post.status === 'partial') {
      await db.update(posts).set({ status: 'cancelled' }).where(eq(posts.id, id))
    } else {
      await db.delete(posts).where(eq(posts.id, id))
    }
    return { ok: true }
  })
}
