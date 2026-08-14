import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { posts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { drain } from '@/lib/drain'
import { bad, handle } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Runs the queue right now, on the authority of a signed-in member.
 *
 * Where there is no long-running worker, "Publish now" would otherwise sit
 * until the next cron tick. The composer fires this without awaiting it and
 * navigates on; whatever this invocation does not finish, cron picks up.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
    if (!post) throw bad('Post not found', 404)
    await requireMembership(post.workspaceId)

    // Leave headroom under the platform's function timeout.
    const result = await drain({ budgetMs: 45_000 })
    return { done: result.done, failed: result.failed, timedOut: result.timedOut }
  })
}
