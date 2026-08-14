import { db } from '@/db'
import { workspaceMembers, workspaces } from '@/db/schema'
import { listWorkspaces, requireUser } from '@/lib/auth'
import { bad, handle } from '@/lib/api'

export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    const rows = await listWorkspaces(user.id)
    return { user: { id: user.id, name: user.name, email: user.email }, workspaces: rows }
  })
}

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { name } = await req.json()
    if (!name) throw bad('name is required')
    const slug = `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Math.random().toString(36).slice(2, 7)}`
    const [ws] = await db.insert(workspaces).values({ name, slug }).returning()
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: 'owner' })
    return ws
  })
}
