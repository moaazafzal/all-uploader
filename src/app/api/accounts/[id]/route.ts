import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { socialAccounts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { bad, handle } from '@/lib/api'

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params
    const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, id)).limit(1)
    if (!row) throw bad('Account not found', 404)
    await requireMembership(row.workspaceId, 'admin')
    await db.delete(socialAccounts).where(eq(socialAccounts.id, id))
    return { ok: true }
  })
}
