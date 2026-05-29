'use client'

import { useState, useMemo, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRouter, usePathname } from 'next/navigation'
import { Plus, FileText, FolderOpen, MoreHorizontal, X, Check, Pin as PinIcon, Music, Zap, ChevronLeft, ChevronRight, Workflow, Combine, Monitor, Settings, LogOut, Upload, Zap as BoltIcon, Search, Tag as TagIcon } from 'lucide-react'
import { toast } from 'sonner'
import { ArrangementTagsDialog } from '@/domain/arrangement/components/ArrangementTagsDialog'
import { ArrangementService } from '@/domain/arrangement/services'
import { Union } from '@/lib/types'
import {
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuSub,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { useArrangements } from '@/domain/arrangement/hooks/useArrangements'
import { usePreloadedArrangements } from '@/domain/arrangement/hooks/usePreloadedArrangements'
import { getLastVisitedMap, recordVisit } from '@/domain/arrangement/lib/last-visited'
import { useAuth } from '@/domain/auth/hooks/useAuth'
import { cn } from '@/lib/utils'
import { Arrangement } from '@piano/shared'
import { Z } from '@/domain/canvas/lib/z-layers'

interface AppSidebarProps {
  className?: string
  isCollapsed?: boolean
  arrangements: Arrangement.Model[]
  selectedId: string | null
  onSelectArrangement: (id: string) => void
  onCollapse?: () => void
}

function ArrangementColumn({
  title,
  icon,
  rows,
  emptyText,
  renderRow,
}: {
  title: string
  icon: ReactNode
  rows: Arrangement.Model[]
  emptyText: string
  renderRow: (
    arrangement: Arrangement.Model,
    options?: { icon?: ReactNode; showTags?: boolean; compact?: boolean; inFlyout?: boolean },
  ) => ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-card/95 px-3 py-2 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground">{rows.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-0.5">
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-[11px] italic text-muted-foreground">{emptyText}</div>
        ) : (
          rows.map(arrangement => (
            <div key={arrangement.id}>
              {renderRow(arrangement, { showTags: true, compact: true, inFlyout: true })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function formatLastVisit(timestamp: number | null): string {
  if (!timestamp) return 'Never visited'
  const deltaMs = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (deltaMs < minute) return 'Visited just now'
  if (deltaMs < hour) return `Visited ${Math.max(1, Math.floor(deltaMs / minute))}m ago`
  if (deltaMs < day) return `Visited ${Math.floor(deltaMs / hour)}h ago`
  if (deltaMs < 7 * day) return `Visited ${Math.floor(deltaMs / day)}d ago`
  return `Visited ${new Date(timestamp).toLocaleDateString()}`
}

function dateMs(value: Date | string | null | undefined): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function AppSidebar({
  className,
  isCollapsed = false,
  arrangements,
  selectedId,
  onSelectArrangement,
  onCollapse
}: AppSidebarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { createArrangement, updateArrangement, deleteArrangement, importArrangement, isCreating, isUpdating, isDeleting, isImporting } = useArrangements()
  const { isPreloaded, togglePreloaded } = usePreloadedArrangements()
  const { user, signOut } = useAuth()
  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [arrangementsSearch, setArrangementsSearch] = useState('')
  const [isArrangementsFlyoutOpen, setIsArrangementsFlyoutOpen] = useState(false)
  // AND-filter on arrangement tags. Empty list = no filter.
  const [tagFilterTags, setTagFilterTags] = useState<string[]>([])
  const arrangementsCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [lastVisitedMap, setLastVisitedMap] = useState<Record<string, number>>({})

  // Tag-editing dialog: opened from the per-item dropdown menu
  const [tagsDialogArr, setTagsDialogArr] = useState<Arrangement.Model | null>(null)

  const handleOpenTagsDialog = (arr: Arrangement.Model) => {
    setTagsDialogArr(arr)
    if (arrangementsCloseTimeoutRef.current) {
      clearTimeout(arrangementsCloseTimeoutRef.current)
      arrangementsCloseTimeoutRef.current = null
    }
    setIsArrangementsFlyoutOpen(false)
  }

  const handleSaveTags = async (id: string, tags: string[]) => {
    const result = await updateArrangement(id, { tags })
    if (!result.success) {
      toast.error(`Failed to update tags: ${result.error}`)
    }
  }

  // Hidden file input used by the Import button.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const handleImportClick = () => fileInputRef.current?.click()

  const [exportingId, setExportingId] = useState<string | null>(null)
  const handleExportArrangement = async (id: string) => {
    setExportingId(id)
    const result = await ArrangementService.exportAsJson(id)
    Union.match({
      success: ({ noteCount }) => toast.success(`Exported ${noteCount} note${noteCount !== 1 ? 's' : ''}`),
      error: (err) => toast.error(`Export failed: ${err.message}`),
    }, result)
    setExportingId(null)
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    try {
      const text = await file.text()
      const raw = JSON.parse(text)
      const result = await importArrangement(raw as Arrangement.ExportDoc.Document)
      if (result.success) {
        toast.success(`Imported "${result.data.title}"`)
        onSelectArrangement(result.data.id)
      } else {
        toast.error(`Import failed: ${result.error}`)
      }
    } catch (err) {
      toast.error(`Invalid JSON: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  // Get user initials for avatar
  const userInitials = user?.name
    ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.[0]?.toUpperCase() || 'U'

  const handleCreate = async () => {
    if (!newTitle.trim() || isCreating) return

    const result = await createArrangement(newTitle.trim())
    if (result.success) {
      setNewTitle('')
      setIsCreatingNew(false)
    }
  }

  const handleCancelCreate = () => {
    setIsCreatingNew(false)
    setNewTitle('')
  }

  const handleStartEdit = (arrangement: Arrangement.Model) => {
    setEditingId(arrangement.id)
    setEditTitle(arrangement.title)
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editTitle.trim() || isUpdating) return

    const result = await updateArrangement(editingId, { title: editTitle.trim() })
    if (result.success) {
      setEditingId(null)
      setEditTitle('')
    }
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditTitle('')
  }

  const handleTogglePin = async (id: string, currentPinned: boolean) => {
    if (isUpdating) return

    const result = await updateArrangement(id, { pinned: !currentPinned })
    if (!result.success) {
      console.error('Failed to toggle pin:', result.error)
    }
  }

  const handleDelete = async (id: string) => {
    if (isDeleting) return

    if (!confirm('Are you sure you want to delete this project?')) return

    await deleteArrangement(id)
  }

  const arrangementHref = (id: string) => `/arrangements?id=${encodeURIComponent(id)}`

  const handleSelect = (id: string, e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    recordVisit(id)
    setLastVisitedMap(getLastVisitedMap())
    onSelectArrangement(id)
  }

  useEffect(() => {
    setLastVisitedMap(getLastVisitedMap())
  }, [selectedId])

  // Sub-arrangements are gone — every arrangement is a "root" now. The
  // sidebar still wants the same pinned-first / recent-first ordering, just
  // without the parent filter.
  const rootArrangements = useMemo(() => {
    return [...arrangements]
      .sort((a, b) => {
        if ((a.pinned || false) !== (b.pinned || false)) return (a.pinned || false) ? -1 : 1
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
  }, [arrangements])

  const lastVisitMs = useCallback(
    (arrangement: Arrangement.Model) =>
      dateMs(arrangement.lastVisitedAt) ?? lastVisitedMap[arrangement.id] ?? null,
    [lastVisitedMap],
  )

  const lastVisitedRanked = useMemo(() => {
    return [...rootArrangements].sort((a, b) => {
      const av = lastVisitMs(a) ?? new Date(a.updatedAt).getTime()
      const bv = lastVisitMs(b) ?? new Date(b.updatedAt).getTime()
      return bv - av
    })
  }, [lastVisitMs, rootArrangements])

  const topFiveSurface = useMemo(() => {
    const pinned = rootArrangements.filter(a => a.pinned)
    const pinnedIds = new Set(pinned.map(a => a.id))
    const recents = lastVisitedRanked.filter(a => !pinnedIds.has(a.id))
    return [...pinned, ...recents].slice(0, 5)
  }, [lastVisitedRanked, rootArrangements])

  // All tags across all arrangements — powers the filter chip row.
  const allTags = useMemo(() => Arrangement.collectAllTags(arrangements), [arrangements])

  const top3Tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const arrangement of rootArrangements) {
      for (const tag of arrangement.tags || []) {
        counts.set(tag, (counts.get(tag) || 0) + 1)
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([tag]) => tag)
  }, [rootArrangements])
  const flyoutColumnCount = 2 + top3Tags.length
  const arrangementFlyoutWidth = `min(${Math.min(860, flyoutColumnCount * 190)}px, calc(100vw - 280px))`

  // Two-stage filter: AND-tag filter first (structural), then text search
  // (fuzzy over title + tags). Empty filters are passthrough.
  const flyoutArrangements = useMemo(() => {
    const query = arrangementsSearch.trim().toLowerCase()
    return rootArrangements.filter(arrangement => {
      if (tagFilterTags.length > 0 && !Arrangement.hasAllTags(arrangement, tagFilterTags)) return false
      if (!query) return true
      const haystack = `${arrangement.title} ${(arrangement.tags || []).join(' ')}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [arrangementsSearch, rootArrangements, tagFilterTags])

  const openArrangementsFlyout = useCallback(() => {
    if (arrangementsCloseTimeoutRef.current) {
      clearTimeout(arrangementsCloseTimeoutRef.current)
      arrangementsCloseTimeoutRef.current = null
    }
    setIsArrangementsFlyoutOpen(true)
  }, [])

  const closeArrangementsFlyoutSoon = useCallback(() => {
    if (arrangementsCloseTimeoutRef.current) {
      clearTimeout(arrangementsCloseTimeoutRef.current)
    }
    const tick = () => {
      const hasOpenPortal = typeof document !== 'undefined' && document.querySelector(
        '[data-radix-popper-content-wrapper] [data-state="open"], [role="dialog"][data-state="open"]'
      ) !== null
      if (hasOpenPortal) {
        arrangementsCloseTimeoutRef.current = setTimeout(tick, 250)
        return
      }
      arrangementsCloseTimeoutRef.current = null
      setIsArrangementsFlyoutOpen(false)
    }
    arrangementsCloseTimeoutRef.current = setTimeout(tick, 180)
  }, [])

  const toggleTagFilter = useCallback((tag: string) => {
    setTagFilterTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])
  }, [])

  useEffect(() => {
    return () => {
      if (arrangementsCloseTimeoutRef.current) {
        clearTimeout(arrangementsCloseTimeoutRef.current)
      }
    }
  }, [])

  const renderArrangementEditor = (autoFocus = false) => (
    <div className="rounded bg-muted/10 p-2">
      <Input
        value={editTitle}
        onChange={(e) => setEditTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSaveEdit()
          if (e.key === 'Escape') handleCancelEdit()
        }}
        autoFocus={autoFocus}
        className="mb-2 w-full"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleSaveEdit}
          disabled={!editTitle.trim() || isUpdating}
          className="flex-1"
        >
          <Check className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCancelEdit}
          disabled={isUpdating}
          className="flex-1"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )

  const renderArrangementEntry = (
    arrangement: Arrangement.Model,
    options: {
      icon?: ReactNode
      showTags?: boolean
      compact?: boolean
      inFlyout?: boolean
    } = {},
  ) => {
    if (editingId === arrangement.id) {
      return renderArrangementEditor(options.inFlyout)
    }
    const visitMs = lastVisitMs(arrangement)
    const isSelected = selectedId === arrangement.id

    return (
      <div
        className={cn(
          'relative w-full overflow-hidden rounded-md hover:bg-accent',
          'flex items-center justify-between gap-2',
          isSelected && [
            'bg-slate-950/[0.06] text-foreground shadow-inner ring-1 ring-slate-950/10',
            'before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-slate-700',
          ],
        )}
      >
        <a
          href={arrangementHref(arrangement.id)}
          onClick={(e) => handleSelect(arrangement.id, e)}
          className={cn(
            'flex min-w-0 flex-1 items-center p-2 text-inherit no-underline',
            options.compact && 'px-2 py-1.5',
          )}
        >
          <div className="mr-2 flex h-4 w-4 flex-shrink-0 items-center justify-center">
            {options.icon || <FileText className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-1 truncate">
              {isPreloaded(arrangement.id) ? (
                <BoltIcon className="h-3 w-3 flex-shrink-0 fill-yellow-400 text-yellow-500" />
              ) : null}
              {arrangement.title}
            </span>
            {options.showTags && (arrangement.tags?.length || 0) > 0 ? (
              <div className="mt-0.5 flex flex-wrap gap-0.5">
                {arrangement.tags.slice(0, options.inFlyout ? 4 : 3).map(tag => (
                  <span
                    key={tag}
                    className="rounded bg-blue-100 px-1 py-0 text-[9px] leading-tight text-blue-700"
                  >
                    {tag}
                  </span>
                ))}
                {arrangement.tags.length > (options.inFlyout ? 4 : 3) ? (
                  <span className="text-[9px] text-muted-foreground">
                    +{arrangement.tags.length - (options.inFlyout ? 4 : 3)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {options.inFlyout ? (
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {formatLastVisit(visitMs)}
              </div>
            ) : null}
          </div>
        </a>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6 flex-shrink-0 p-0"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            style={options.inFlyout ? { zIndex: Z.sidebarFlyout + 100 } : undefined}
          >
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleStartEdit(arrangement) }}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={async (e) => { e.stopPropagation(); await handleTogglePin(arrangement.id, arrangement.pinned || false) }}>
              {arrangement.pinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleOpenTagsDialog(arrangement) }}>
              Edit tags…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); togglePreloaded(arrangement.id) }}>
              {isPreloaded(arrangement.id) ? 'Unpreload' : 'Preload (fast switch)'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={async (e) => { e.stopPropagation(); await handleExportArrangement(arrangement.id) }} disabled={exportingId === arrangement.id}>
              Export as JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={async (e) => { e.stopPropagation(); await handleDelete(arrangement.id) }} className="text-destructive">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col transition-all duration-300 ease-in-out bg-card text-card-foreground h-screen", isCollapsed ? "w-16" : "w-64", className)}>
      {/* Main content area that grows */}
      <div className="flex-1 flex flex-col min-h-0">
        <SidebarHeader className={cn(isCollapsed && "px-2")}>
          <div className="flex items-center justify-between p-4">
            <div className={cn("flex items-center gap-2", isCollapsed && "w-8 justify-center")}>
              <Music className="w-4 h-4 mr-2" />
              <h1 className={cn("text-xl font-bold", isCollapsed && "sr-only")}>Piano</h1>
              <p className={cn("text-xs text-muted-foreground", isCollapsed && "sr-only")}>Your AI canvas</p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent className={cn("flex flex-col flex-1 overflow-y-auto", isCollapsed && "p-1")}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuButton
                onClick={() => router.push('/actions')}
                className={cn(
                  'justify-start',
                  isCollapsed && 'justify-center p-0 gap-0 w-full',
                  pathname === '/actions' && 'bg-accent text-accent-foreground',
                )}
              >
                <Zap className="h-4 w-4" />
                {!isCollapsed && <span className="ml-2">Actions</span>}
              </SidebarMenuButton>
            </SidebarMenu>

            <SidebarMenu className="mt-2">
              <SidebarMenuButton
                onClick={() => router.push('/workflows')}
                className={cn(
                  'justify-start',
                  isCollapsed && 'justify-center p-0 gap-0 w-full',
                  pathname === '/workflows' && 'bg-accent text-accent-foreground',
                )}
              >
                <Workflow className="h-4 w-4" />
                {!isCollapsed && <span className="ml-2">Workflows</span>}
              </SidebarMenuButton>
            </SidebarMenu>

            <SidebarMenu className="mt-2">
              <SidebarMenuButton
                onClick={() => router.push('/machines')}
                className={cn(
                  'justify-start',
                  isCollapsed && 'justify-center p-0 gap-0 w-full',
                  pathname === '/machines' && 'bg-accent text-accent-foreground',
                )}
              >
                <Monitor className="h-4 w-4" />
                {!isCollapsed && <span className="ml-2">Machines</span>}
              </SidebarMenuButton>
            </SidebarMenu>

            <SidebarMenu className="mt-2">
              <SidebarMenuButton
                onClick={() => router.push('/unifiers')}
                className={cn(
                  'justify-start',
                  isCollapsed && 'justify-center p-0 gap-0 w-full',
                  pathname === '/unifiers' && 'bg-accent text-accent-foreground',
                )}
              >
                <Combine className="h-4 w-4" />
                {!isCollapsed && <span className="ml-2">Unifiers</span>}
              </SidebarMenuButton>
            </SidebarMenu>

            <div className="mb-2 mt-6 border-t border-border" />

            {arrangements.length === 0 ? (
              <div className="text-center py-8 px-4">
                <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground mb-1">No projects yet</p>
                <p className="text-xs text-muted-foreground mb-4">Create your first canvas</p>
                {isCollapsed ? (
                  <Button
                    size="icon"
                    onClick={() => setIsCreatingNew(true)}
                    className="mx-auto"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                ) : (
                  <>
                    {!isCreatingNew ? (
                      <Button
                        size="sm"
                        onClick={() => setIsCreatingNew(true)}
                        className="w-full"
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        New Project
                      </Button>
                    ) : (
                      <div className="space-y-2 p-3 bg-muted/10 rounded-lg border border-border">
                        <Input
                          value={newTitle}
                          onChange={(e) => setNewTitle(e.target.value)}
                          placeholder="Project title..."
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreate()
                            if (e.key === 'Escape') handleCancelCreate()
                          }}
                          autoFocus
                          className="w-full"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={handleCreate}
                            disabled={!newTitle.trim() || isCreating}
                            className="flex-1"
                          >
                            {isCreating ? 'Creating...' : 'Create'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleCancelCreate}
                            disabled={isCreating}
                            className="flex-1"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <>
                <div
                  className="relative"
                  onMouseEnter={openArrangementsFlyout}
                  onMouseLeave={closeArrangementsFlyoutSoon}
                >
                  <SidebarMenu>
                    <SidebarMenuButton
                      onClick={() => {
                        if (isCollapsed) router.push('/arrangements')
                        else setIsArrangementsFlyoutOpen(true)
                      }}
                      className={cn(
                        'justify-start',
                        isCollapsed && 'justify-center p-0 gap-0 w-full',
                        pathname === '/arrangements' && 'bg-accent text-accent-foreground',
                      )}
                      title="Open projects"
                    >
                      <FolderOpen className="h-4 w-4" />
                      {!isCollapsed && <span className="ml-2">Projects</span>}
                    </SidebarMenuButton>
                  </SidebarMenu>

                  {!isCollapsed && topFiveSurface.length > 0 && (
                    <SidebarMenuSub className="mx-0 mt-1 px-1">
                      {topFiveSurface.map(arrangement => (
                        <li key={arrangement.id} className="list-none">
                          {renderArrangementEntry(arrangement, {
                            icon: arrangement.pinned
                              ? <PinIcon className="h-4 w-4" />
                              : <FileText className="h-4 w-4" />,
                            compact: true,
                          })}
                        </li>
                      ))}
                    </SidebarMenuSub>
                  )}

                  {isArrangementsFlyoutOpen && !isCollapsed && typeof window !== 'undefined' && createPortal(
                    <div
                      className="fixed inset-y-0 flex flex-col border-r border-border bg-card"
                      style={{ left: 256, zIndex: Z.sidebarFlyout, width: arrangementFlyoutWidth }}
                      onMouseEnter={openArrangementsFlyout}
                      onMouseLeave={closeArrangementsFlyoutSoon}
                    >
                      {/* Header — title + counts + close */}
                      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
                        <div className="min-w-0">
                          <h2 className="text-sm font-semibold leading-tight">Projects</h2>
                          <p className="text-[11px] text-muted-foreground">
                            {flyoutArrangements.length === rootArrangements.length
                              ? `${rootArrangements.length} total`
                              : `${flyoutArrangements.length} of ${rootArrangements.length}`}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setIsArrangementsFlyoutOpen(false)}
                          title="Close"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>

                      {/* Actions row — New / Import */}
                      <div className="border-b border-border px-4 py-3">
                        <div className="flex max-w-[420px] gap-2">
                          <Button
                            size="sm"
                            onClick={() => setIsCreatingNew(true)}
                            className="justify-start"
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            New project
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleImportClick}
                            disabled={isImporting}
                            title="Import project from JSON file"
                          >
                            <Upload className="h-4 w-4" />
                          </Button>
                        </div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={handleFileSelected}
                        />
                      </div>

                      {/* Search */}
                      <div className="border-b border-border px-4 py-3">
                        <div className="relative max-w-[420px]">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={arrangementsSearch}
                            onChange={(e) => setArrangementsSearch(e.target.value)}
                            placeholder="Search by name or tag…"
                            className="h-9 pl-8"
                          />
                        </div>
                      </div>

                      {/* Tag filter — AND across all selected tags. */}
                      {allTags.length > 0 && (
                        <div className="border-b border-border px-4 py-3">
                          <div className="mb-2 flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              <TagIcon className="h-3 w-3" />
                              Filter by tag
                              {tagFilterTags.length > 0 && (
                                <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] normal-case tracking-normal text-foreground">
                                  {tagFilterTags.length} · AND
                                </span>
                              )}
                            </div>
                            {tagFilterTags.length > 0 && (
                              <button
                                type="button"
                                className="text-[11px] text-muted-foreground hover:text-foreground"
                                onClick={() => setTagFilterTags([])}
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <div className="flex max-h-[88px] flex-wrap gap-1.5 overflow-y-auto pr-1">
                            {allTags.map(tag => {
                              const active = tagFilterTags.includes(tag)
                              return (
                                <Badge
                                  key={tag}
                                  variant={active ? 'default' : 'outline'}
                                  onClick={() => toggleTagFilter(tag)}
                                  className={cn(
                                    'cursor-pointer select-none font-medium',
                                    !active && 'hover:bg-accent hover:text-accent-foreground',
                                  )}
                                >
                                  {tag}
                                </Badge>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* Inline create form (opens via header "New" button) */}
                      {isCreatingNew ? (
                        <div className="border-b border-border bg-muted/20 px-4 py-3">
                          <Input
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            placeholder="Project title..."
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleCreate()
                              if (e.key === 'Escape') handleCancelCreate()
                            }}
                            autoFocus
                            className="mb-2 w-full"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={handleCreate}
                              disabled={!newTitle.trim() || isCreating}
                              className="flex-1"
                            >
                              {isCreating ? 'Creating...' : 'Create'}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleCancelCreate}
                              disabled={isCreating}
                              className="flex-1"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {(() => {
                        const filteredById = new Set(flyoutArrangements.map(a => a.id))
                        const pinnedCol = lastVisitedRanked.filter(a => a.pinned && filteredById.has(a.id))
                        const recentsCol = lastVisitedRanked.filter(a => !a.pinned && filteredById.has(a.id))
                        const tagColumns = top3Tags.map(tag => ({
                          tag,
                          rows: lastVisitedRanked.filter(
                            a => filteredById.has(a.id) && (a.tags || []).includes(tag),
                          ),
                        }))
                        return (
                          <div className="flex-1 overflow-auto">
                            {flyoutArrangements.length === 0 ? (
                              <div className="mx-2 mt-4 rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                                {rootArrangements.length === 0
                                  ? 'No arrangements yet'
                                  : 'Nothing matches your filters'}
                              </div>
                            ) : (
                              <div
                                className="inline-grid min-h-full divide-x divide-border"
                                style={{ gridTemplateColumns: `repeat(${flyoutColumnCount}, minmax(165px, 190px))` }}
                              >
                                <ArrangementColumn
                                  title="Pinned"
                                  icon={<PinIcon className="h-3 w-3" />}
                                  rows={pinnedCol}
                                  emptyText="Nothing pinned"
                                  renderRow={renderArrangementEntry}
                                />
                                <ArrangementColumn
                                  title="By last visit"
                                  icon={<FileText className="h-3 w-3" />}
                                  rows={recentsCol}
                                  emptyText="No projects"
                                  renderRow={renderArrangementEntry}
                                />
                                {tagColumns.map(column => (
                                  <ArrangementColumn
                                    key={column.tag}
                                    title={column.tag}
                                    icon={<TagIcon className="h-3 w-3 text-emerald-600" />}
                                    rows={column.rows}
                                    emptyText="-"
                                    renderRow={renderArrangementEntry}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>,
                    document.body,
                  )}
                </div>
              </>
            )}

          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      </div>

      {/* Footer with User Menu and Collapse Button */}
      <SidebarFooter className="border-t">
        {/* User Menu */}
        <SidebarMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                className={cn(
                  "justify-start w-full",
                  isCollapsed && "justify-center"
                )}
              >
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                    {userInitials}
                  </AvatarFallback>
                </Avatar>
                {!isCollapsed && (
                  <div className="ml-2 flex flex-col items-start overflow-hidden">
                    <span className="text-sm font-medium truncate max-w-[140px]">
                      {user?.name || 'User'}
                    </span>
                    <span className="text-xs text-muted-foreground truncate max-w-[140px]">
                      {user?.email}
                    </span>
                  </div>
                )}
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={isCollapsed ? "right" : "top"}
              align="start"
              className="w-56"
            >
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{user?.name || 'User'}</p>
                <p className="text-xs text-muted-foreground">{user?.email}</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push('/settings')}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => signOut()}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenu>

        {/* Tag editor dialog (opened from per-arrangement dropdown menu) */}
        <ArrangementTagsDialog
          open={tagsDialogArr !== null}
          arrangement={tagsDialogArr}
          allTags={allTags}
          onClose={() => setTagsDialogArr(null)}
          onSave={handleSaveTags}
        />

        {/* Collapse/Expand Button */}
        {onCollapse && (
          <SidebarMenu>
            <SidebarMenuButton
              onClick={onCollapse}
              className={cn("justify-start", isCollapsed && "justify-center w-full")}
              title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <>
                  <ChevronLeft className="h-4 w-4" />
                  <span className="ml-2">Collapse</span>
                </>
              )}
            </SidebarMenuButton>
          </SidebarMenu>
        )}
      </SidebarFooter>
    </div>
  )
}
