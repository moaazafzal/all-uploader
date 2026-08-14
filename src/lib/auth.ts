import { cookies } from 'next/headers'
import { and, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import { sessions, users, workspaceMembers, workspaces } from '@/db/schema'
import { hashPassword, verifyPassword } from './crypto'

const COOKIE = 'au_session'
const SESSION_DAYS = 30

export async function createSession(userId: string) {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  const [row] = await db.insert(sessions).values({ userId, expiresAt }).returning()
  const jar = await cookies()
  jar.set(COOKIE, row.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })
  return row
}

export async function destroySession() {
  const jar = await cookies()
  const id = jar.get(COOKIE)?.value
  if (id) await db.delete(sessions).where(eq(sessions.id, id))
  jar.delete(COOKIE)
}

export async function currentUser() {
  const jar = await cookies()
  const id = jar.get(COOKIE)?.value
  if (!id) return null
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1)
  return rows[0]?.user ?? null
}

export async function requireUser() {
  const user = await currentUser()
  if (!user) throw new HttpError(401, 'Not signed in')
  return user
}

/**
 * Every data read is scoped through a membership check. Without this, any
 * signed-in user could pass another workspace's id and read its tokens.
 */
export async function requireMembership(workspaceId: string, minRole: 'member' | 'admin' | 'owner' = 'member') {
  const user = await requireUser()
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)))
    .limit(1)
  if (!row) throw new HttpError(404, 'Workspace not found')

  const rank = { member: 0, admin: 1, owner: 2 }
  if (rank[row.role] < rank[minRole]) {
    throw new HttpError(403, `This action requires the ${minRole} role.`)
  }
  return { user, membership: row }
}

export async function listWorkspaces(userId: string) {
  return db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
}

export async function signUp(email: string, name: string, password: string) {
  const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)
  if (existing.length) throw new HttpError(409, 'An account with that email already exists.')
  const [user] = await db
    .insert(users)
    .values({ email: email.toLowerCase(), name, passwordHash: hashPassword(password) })
    .returning()
  return user
}

export async function signIn(email: string, password: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)
  // Same message either way -- do not reveal which emails exist.
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, 'Wrong email or password.')
  }
  return user
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}
