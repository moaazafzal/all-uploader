import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { socialAccounts } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { publicAccount } from '@/lib/accounts'
import { bad, handle } from '@/lib/api'

export async function GET(req: Request) {
  return handle(async () => {
    const workspaceId = new URL(req.url).searchParams.get('workspace')
    if (!workspaceId) throw bad('workspace is required')
    await requireMembership(workspaceId)
    const rows = await db.select().from(socialAccounts).where(eq(socialAccounts.workspaceId, workspaceId))
    return rows.map(publicAccount)
  })
}
