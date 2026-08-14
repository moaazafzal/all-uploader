import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditLog, posts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { schedulePost } from '@/lib/publish'
import { bad, handle } from '@/lib/api'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
    if (!post) throw bad('Post not found', 404)
    const { user } = await requireMembership(post.workspaceId, 'member')

    const body = await req.json().catch(() => ({}))
    const runAt = body.scheduledAt ? new Date(body.scheduledAt) : undefined
    const count = await schedulePost(id, runAt)

    await db.insert(auditLog).values({
      workspaceId: post.workspaceId,
      userId: user.id,
      action: runAt && runAt > new Date() ? 'post.scheduled' : 'post.published',
      subject: id,
      detail: { targets: count, runAt: runAt?.toISOString() },
    })
    return { queued: count, runAt: runAt ?? new Date() }
  })
}
