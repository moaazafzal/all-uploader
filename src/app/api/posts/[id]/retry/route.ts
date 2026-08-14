import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { posts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { retryFailedTargets } from '@/lib/publish'
import { bad, handle } from '@/lib/api'

/** Re-runs only the destinations that failed. Successful ones are left alone. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
    if (!post) throw bad('Post not found', 404)
    await requireMembership(post.workspaceId)
    const n = await retryFailedTargets(id)
    if (!n) throw bad('Nothing failed on this post.')
    return { retrying: n }
  })
}
