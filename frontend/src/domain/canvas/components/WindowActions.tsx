'use client'

/**
 * Unified action framework for canvas windows.
 *
 * Every action on a window (close, minimize, maximize/restore, add tab,
 * toggle tab layout, …) is declared ONCE in `WINDOW_ACTIONS` below. The
 * declaration carries everything a renderer needs: visibility predicate,
 * tooltip, icon, an optional "active" highlight, and the invocation.
 *
 * The same action set is rendered by `<WindowActionBar>` in TWO places:
 *   1. The header of an open/maximized window.
 *   2. An overlay strip on top of a docked thumbnail.
 *
 * Adding a new action = append one entry here. Both UIs pick it up, and
 * TypeScript fails anywhere the handler list is incomplete.
 */

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Plus, X, Minus, Maximize2, Minimize2, Rows, Columns } from 'lucide-react'
import { cn } from '@/lib/utils'

export type WindowMode = 'open' | 'minimized' | 'maximized'

export interface WindowActionCtx {
  state: WindowMode
  tabCount: number
  tabLayout: 'horizontal' | 'vertical'
  collectingTabs: boolean
}

export interface WindowActionHandlers {
  onClose: () => void
  onMinimize: () => void
  /** Toggles between 'open' and 'maximized'. */
  onMaximize: () => void
  onRestore: () => void
  onBeginAddTab: () => void
  onToggleTabLayout: () => void
}

type ButtonTone = 'close' | 'minimize' | 'maximize' | 'neutral'

export interface WindowAction {
  id: string
  tone: ButtonTone
  show: (ctx: WindowActionCtx) => boolean
  tooltip: (ctx: WindowActionCtx) => string
  icon: (ctx: WindowActionCtx) => ReactNode
  /** When true the button gets a highlighted "sticky" state. */
  active?: (ctx: WindowActionCtx) => boolean
  invoke: (h: WindowActionHandlers, ctx: WindowActionCtx) => void
}

export const WINDOW_ACTIONS: WindowAction[] = [
  {
    id: 'close',
    tone: 'close',
    show: () => true,
    tooltip: () => 'Close',
    icon: () => <X className="h-3 w-3" />,
    invoke: (h) => h.onClose(),
  },
  {
    id: 'minimize',
    tone: 'minimize',
    // Already minimized → restore takes this slot instead.
    show: (ctx) => ctx.state !== 'minimized',
    tooltip: () => 'Minimize',
    icon: () => <Minus className="h-3 w-3" />,
    invoke: (h) => h.onMinimize(),
  },
  {
    id: 'restore',
    tone: 'minimize',
    show: (ctx) => ctx.state === 'minimized',
    tooltip: () => 'Restore',
    icon: () => <Maximize2 className="h-3 w-3" />,
    invoke: (h) => h.onRestore(),
  },
  {
    id: 'maximize',
    tone: 'maximize',
    // Maximize is only meaningful for non-minimized windows.
    show: (ctx) => ctx.state !== 'minimized',
    tooltip: (ctx) => (ctx.state === 'maximized' ? 'Restore size' : 'Maximize'),
    icon: (ctx) =>
      ctx.state === 'maximized'
        ? <Minimize2 className="h-3 w-3" />
        : <Maximize2 className="h-3 w-3" />,
    invoke: (h) => h.onMaximize(),
  },
  {
    id: 'beginAddTab',
    tone: 'neutral',
    show: () => true,
    tooltip: (ctx) =>
      ctx.collectingTabs
        ? 'Cancel tab collection'
        : 'Add selected or next clicked node as tab',
    icon: () => <Plus className="h-3 w-3" />,
    active: (ctx) => ctx.collectingTabs,
    invoke: (h) => h.onBeginAddTab(),
  },
  {
    id: 'toggleTabLayout',
    tone: 'neutral',
    show: () => true,
    tooltip: (ctx) =>
      ctx.tabLayout === 'horizontal' ? 'Tabs vertical' : 'Tabs horizontal',
    icon: (ctx) =>
      ctx.tabLayout === 'horizontal'
        ? <Rows className="h-3 w-3" />
        : <Columns className="h-3 w-3" />,
    invoke: (h) => h.onToggleTabLayout(),
  },
]

const TONE_CLASS: Record<ButtonTone, string> = {
  close: 'text-slate-500 hover:bg-red-500/15 hover:text-red-600',
  minimize: 'text-slate-500 hover:bg-amber-400/20 hover:text-amber-700',
  maximize: 'text-slate-500 hover:bg-emerald-500/15 hover:text-emerald-700',
  neutral: 'text-slate-500 hover:bg-black/5 hover:text-slate-800',
}

/**
 * Render the currently-visible actions as a horizontal button row.
 * stopPropagation on both mousedown and click so neither drag-to-move
 * (parent header) nor click-to-restore (parent dock thumbnail) fires.
 */
export function WindowActionBar({
  ctx,
  handlers,
  className,
}: {
  ctx: WindowActionCtx
  handlers: WindowActionHandlers
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {WINDOW_ACTIONS.filter((a) => a.show(ctx)).map((a) => {
        const isActive = a.active?.(ctx) ?? false
        const label = a.tooltip(ctx)
        return (
          <button
            key={a.id}
            type="button"
            aria-label={label}
            title={label}
            onMouseDown={(e: ReactMouseEvent) => e.stopPropagation()}
            onClick={(e: ReactMouseEvent) => {
              e.stopPropagation()
              a.invoke(handlers, ctx)
            }}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-full border border-black/10 bg-white/80 transition',
              TONE_CLASS[a.tone],
              isActive && 'border-sky-300 bg-sky-100 text-sky-700',
            )}
          >
            {a.icon(ctx)}
          </button>
        )
      })}
    </div>
  )
}
