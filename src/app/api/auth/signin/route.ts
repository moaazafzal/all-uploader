import { createSession, signIn } from '@/lib/auth'
import { bad, handle } from '@/lib/api'

export async function POST(req: Request) {
  return handle(async () => {
    const { email, password } = await req.json()
    if (!email || !password) throw bad('Email and password are required.')
    const user = await signIn(email, password)
    await createSession(user.id)
    return { user: { id: user.id, email: user.email, name: user.name } }
  })
}
