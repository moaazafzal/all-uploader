import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser, listWorkspaces } from '@/lib/auth'
import { WorkspaceProvider } from '@/components/workspace-context'
import SignOutButton from '@/components/sign-out-button'

const NAV = [
  { href: '/compose', label: 'Compose' },
  { href: '/posts', label: 'Posts' },
  { href: '/accounts', label: 'Accounts' },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user) redirect('/signin')
  const memberships = await listWorkspaces(user.id)
  if (!memberships.length) redirect('/signin')

  return (
    <WorkspaceProvider
      value={{
        user: { id: user.id, name: user.name, email: user.email },
        workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
      }}
    >
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-line sticky top-0 bg-bg/90 backdrop-blur z-20">
          <div className="max-w-6xl mx-auto px-5 h-14 flex items-center gap-6">
            <Link href="/compose" className="font-semibold tracking-tight">All Uploader</Link>
            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="px-3 py-1.5 rounded-md hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)]">
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm text-muted">
              <span className="hidden sm:inline">{user.name}</span>
              <SignOutButton />
            </div>
          </div>
        </header>
        <main className="flex-1 max-w-6xl mx-auto w-full px-5 py-6">{children}</main>
      </div>
    </WorkspaceProvider>
  )
}
