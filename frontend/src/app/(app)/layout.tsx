'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'
import { useAuth } from '@/domain/auth/hooks/useAuth'
import { useArrangements } from '@/domain/arrangement/hooks/useArrangements'
import { pruneStaleViewports } from '@/domain/canvas/lib/viewport-persistence'
import { pruneStaleCollapse } from '@/domain/canvas/lib/collapse-persistence'
import { pruneStaleWindows } from '@/domain/canvas/lib/window-persistence'

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const { arrangements, isLoading: arrangementsLoading } = useArrangements()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [selectedArrangementId, setSelectedArrangementId] = useState<string | null>(null)
  const urlArrangementId = pathname === '/arrangements' ? searchParams.get('id') : null
  const currentSelectedArrangementId = pathname === '/arrangements' ? urlArrangementId ?? selectedArrangementId : null

  // Redirect to signin if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/signin')
    }
  }, [authLoading, isAuthenticated, router])

  // Once per session: clean up localStorage entries for deleted arrangements.
  // Both viewport and collapse state share the same lifecycle — they're
  // device-local UI memory tied to an arrangement id, so they get pruned
  // together.
  const prunedRef = useRef(false)
  useEffect(() => {
    if (prunedRef.current || arrangements.length === 0) return
    prunedRef.current = true
    const knownIds = new Set(arrangements.map(a => a.id))
    pruneStaleViewports(knownIds)
    pruneStaleCollapse(knownIds)
    pruneStaleWindows(knownIds)
  }, [arrangements])

  // Handle arrangement selection - navigate to arrangements page
  const handleSelectArrangement = (id: string) => {
    setSelectedArrangementId(id)
    router.push(`/arrangements?id=${id}`)
  }

  // Show loading state
  if (authLoading || arrangementsLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-sm text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  // Don't render anything if not authenticated (will redirect)
  if (!isAuthenticated) {
    return null
  }

  return (
    <SidebarProvider>
      <AppSidebar
        className="max-md:!hidden border-r"
        isCollapsed={isCollapsed}
        arrangements={arrangements}
        selectedId={currentSelectedArrangementId}
        onSelectArrangement={handleSelectArrangement}
        onCollapse={() => setIsCollapsed(!isCollapsed)}
      />
      {children}
    </SidebarProvider>
  )
}
