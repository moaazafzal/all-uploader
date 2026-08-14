import { db } from '@/db'
import { workspaceMembers, workspaces } from '@/db/schema'
import { createSession, signUp } from '@/lib/auth'
import { bad, handle } from '@/lib/api'

export async function POST(req: Request) {
  return handle(async () => {
    const { email, name, password, workspaceName } = await req.json()
    if (!email || !name || !password) throw bad('Email, name and password are all required.')
    if (String(password).length < 10) throw bad('Use a password of at least 10 characters.')

    const user = await signUp(email, name, password)

    // First sign-up creates the workspace and makes that person its owner.
    const slug = slugify(workspaceName || `${name}'s workspace`)
    const [ws] = await db.insert(workspaces).values({ name: workspaceName || `${name}'s workspace`, slug }).returning()
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: 'owner' })

    await createSession(user.id)
    return { user: { id: user.id, email: user.email, name: user.name }, workspace: ws }
  })
}

const slugify = (s: string) =>
  `${s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${Math.random().toString(36).slice(2, 7)}`
