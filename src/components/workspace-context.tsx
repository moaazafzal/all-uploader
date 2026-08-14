'use client'

import { createContext, useContext, useState } from 'react'

export interface WorkspaceInfo {
  id: string
  name: string
  slug: string
  role: 'owner' | 'admin' | 'member'
}

interface Ctx {
  user: { id: string; name: string; email: string }
  workspaces: WorkspaceInfo[]
}

const WorkspaceContext = createContext<(Ctx & { active: WorkspaceInfo; setActive: (id: string) => void }) | null>(null)

export function WorkspaceProvider({ value, children }: { value: Ctx; children: React.ReactNode }) {
  const [activeId, setActiveId] = useState(value.workspaces[0]?.id)
  const active = value.workspaces.find((w) => w.id === activeId) ?? value.workspaces[0]
  return (
    <WorkspaceContext.Provider value={{ ...value, active, setActive: setActiveId }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return ctx
}
