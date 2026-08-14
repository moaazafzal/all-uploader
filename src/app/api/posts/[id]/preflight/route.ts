import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { posts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { preflight } from '@/lib/publish'
import { bad, handle } from '@/lib/api'

/** Dry run: what each platform would say, before anything is sent. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
    if (!post) throw bad('Post not found', 404)
    await requireMembership(post.workspaceId)
    return preflight(id)
  })
}
