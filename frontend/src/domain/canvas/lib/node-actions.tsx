'use client'

/**
 * Unified action registry for canvas nodes.
 *
 * Rule: the menu that appears on a node's 3-dot button MUST be identical
 * whether the node is collapsed on the canvas or opened in a window. The
 * user tripped over this repeatedly because earlier versions let each
 * surface silently gate actions by whether it had wired up a callback,
 * causing the two menus to drift.
 *
 * The fix, enforced architecturally:
 *   1. `show()` is a function of the node's KIND only, never of the
 *      surface's implemented callbacks. If an action applies to a
 *      machine, it shows in both the machine card AND the machine edit
 *      panel — no exceptions.
 *   2. UI pickers (label rename, color, tags, ancestors) are NOT
 *      surface-local popovers anymore. Invoking one asks the global
 *      `nodeDialogsStore` to open a portaled popover anchored to the
 *      click site. A single <NodeDialogsHost> renders them. No surface
 *      owns a duplicate of that UI.
 *   3. Surface callbacks on `NodeActionSurface` are for transient
 *      *feedback* only (copy flash). They can never change which items
 *      appear in the menu.
 *
 * Adding a new action = append one entry to `NODE_ACTIONS`.
 */

import { useMemo, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ClipboardPaste,
  Code,
  Copy,
  Database,
  FolderClosed,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitMerge,
  Info,
  MoreVertical,
  Network,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Snowflake,
  Tag,
  TerminalSquare,
  Trash2,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Note } from '@piano/shared'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { copyToClipboard, cn } from '@/lib/utils'
import { useCanvasStore } from '../store'
import { useMachineCenterStore } from '@/domain/machine-center/store'
import { DaemonService } from '@/domain/daemon/services'
import { CanvasNode } from '../types'
import { anchorFromEvent, useNodeDialogsStore } from './node-dialogs-store'
import { usePinnedToolsStore } from '../hooks/usePinnedToolsStore'

// ============================================================
// Kind classification
// ============================================================

/** UI-level buckets. Maps DB Note.Type values onto interaction kinds. */
export type NodeKind = 'note' | 'text' | 'machine' | 'terminal' | 'annotation'

export function classifyNode(type: Note.Type | string | null | undefined): NodeKind {
  if (type === 'MACHINE') return 'machine'
  if (type === 'TERMINAL') return 'terminal'
  if (type === 'TEXT') return 'text'
  // ZONE / DRAWING are non-content annotations — no action spec targets this
  // kind, so the menu stays empty instead of offering note-only actions
  // (run, merge-point, cache) that make no sense for a shape.
  if (type === 'ZONE' || type === 'DRAWING') return 'annotation'
  return 'note' // USER / ASSISTANT / SYSTEM / legacy GROUP
}

// ============================================================
// Context + surface
// ============================================================

/**
 * Feedback-only callbacks. NEVER gate visibility on these — they exist
 * solely so a surface can flash a "Copied" label next to a menu item.
 */
export interface NodeActionSurface {
  onCopiedContent?: () => void
  /**
   * Some surfaces (notably MachineNode) offer an inline freeze-naming
   * flow next to the node. Providing this overrides the default direct-
   * freeze behaviour. Purely behavioural; does not affect visibility.
   */
  onStartFreezeNaming?: () => void
}

export interface NodeActionCtx {
  node: CanvasNode.UI
  kind: NodeKind
  // Pre-derived flags so actions don't each recompute them.
  isFrozen: boolean
  isPinned: boolean
  isMergePoint: boolean
  isCollapsed: boolean
  /** Raw three-state collapse flag — used by the action registry to pick the
   *  right icon ('recursive' = closed, 'single' = partial, undefined = open). */
  collapseState: 'recursive' | 'single' | undefined
  hasContent: boolean
  /** This machine is the one currently receiving port forwarding. */
  isPortActive: boolean
  /** Transient — set while a "Copied" animation is visible. */
  copiedContent: boolean
  surface: NodeActionSurface
  /**
   * Where this menu is being rendered. Some actions only make sense on
   * canvas (they call canvas-store methods that need a reactflow node,
   * e.g. branch/freeze/delete). Mission Control synthesises a minimal ctx
   * from a machine row, so actions marked `availableIn` list gate here.
   */
  surfaceType: SurfaceType
}

/**
 * Which UI surface is rendering the action registry. Actions default to
 * canvas-only because most of them need a reactflow node in
 * useCanvasStore. Mission Control only sees actions that opt in via
 * `availableIn: [..., 'mission-control']`.
 */
export type SurfaceType = 'canvas' | 'mission-control'

export interface NodeActionSpec {
  id: string
  icon: LucideIcon
  /** Optional state-driven icon override. When present, takes precedence over
   *  `icon` so the same action can show a different glyph per state (e.g.
   *  collapse: open / closed / partial). */
  iconFor?: (ctx: NodeActionCtx) => LucideIcon
  label: (ctx: NodeActionCtx) => string
  /** Pure function of kind + node shape. Never inspect ctx.surface here. */
  show: (ctx: NodeActionCtx) => boolean
  disabled?: (ctx: NodeActionCtx) => boolean
  active?: (ctx: NodeActionCtx) => boolean
  /**
   * Which surfaces this action can render on. Default `['canvas']`. Add
   * `'mission-control'` only for actions whose `invoke()` works from a
   * synthetic node (no reactflow state required) — e.g. port-forward and
   * IDE/SSH actions which just need machineId + label.
   */
  availableIn?: SurfaceType[]
  /**
   * Class applied to the menu item + icon when `active` is true. Overrides
   * the default bold treatment. Used e.g. by cache: the Database icon has
   * internal disk-ring strokes that would flood into a solid blob under
   * `fill-current`, so we colour-only via `text-emerald-600`.
   */
  activeClassName?: string
  destructive?: boolean
  /**
   * The click handler. The second arg carries the DOM rect of the menu
   * item that was clicked, used to anchor portaled popovers. Pass null
   * when invoking outside a click context (programmatic).
   */
  invoke: (ctx: NodeActionCtx, trigger: { currentTarget: EventTarget | null } | null) => void | Promise<void>
}

// ============================================================
// The registry
// ============================================================

const store = () => useCanvasStore.getState()
const dialogs = () => useNodeDialogsStore.getState()

// Shared IDE deep-link helper. Resolves the public SSH endpoint by asking
// the backend for /ssh-info — backend looks up the machine's daemon and
// returns whatever sish tunnel the operator configured for it. Falls back
// to a localStorage-driven legacy URL when the API has no tunnel — that
// path is for single-host dev where the daemon's SSH gateway is reachable
// directly.
async function openInIDE(ctx: NodeActionCtx, editor: 'windsurf' | 'vscode' | 'cursor') {
  const machineId = (CanvasNode.isInfra(ctx.node) ? ctx.node.machineId : null) || ctx.node.id
  const result = await DaemonService.sshInfo(machineId)
  if ('success' in result) {
    const url = editor === 'cursor' ? result.success.cursorUrl : result.success.vscodeUrl
    const finalUrl = editor === 'windsurf' ? url.replace(/^vscode:/, 'windsurf:') : url
    window.open(finalUrl, '_blank')
    toast.success(`Opening ${editor} → ${result.success.host}:${result.success.port}`)
    return
  }
  const sshHost = localStorage.getItem('piano-ssh-host')
  if (!sshHost) {
    toast.error(result.error.message || 'IDE not available for this machine.')
    return
  }
  const sshPort = parseInt(localStorage.getItem('piano-ssh-port') || '2200', 10)
  const homePath = localStorage.getItem('piano-ssh-home') || '/root'
  const uri = `${editor}://vscode-remote/ssh-remote+${machineId}@${sshHost}:${sshPort}${homePath}`
  window.open(uri, '_blank')
  toast.success(`Opening ${editor} (legacy SSH → ${sshHost}:${sshPort})`)
}

export const NODE_ACTIONS: NodeActionSpec[] = [
  {
    id: 'edit-label',
    icon: Pencil,
    label: () => 'Edit label',
    // Task 4: labels are for every kind except pure text annotations.
    show: ctx => ctx.kind !== 'text',
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      if (a) dialogs().open('label', ctx.node.id, a)
    },
  },
  {
    id: 'color',
    icon: Palette,
    label: () => 'Change color',
    // Machine/terminal carry status-based tinting — a user color would fight
    // with that, so we keep the picker note/text only.
    show: ctx => ctx.kind === 'note' || ctx.kind === 'text',
    active: ctx => !!ctx.node.color,
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      if (a) dialogs().open('color', ctx.node.id, a)
    },
  },
  {
    id: 'pin',
    icon: Pin,
    label: ctx => (ctx.isPinned ? 'Unpin' : 'Pin'),
    show: () => true,
    active: ctx => ctx.isPinned,
    invoke: ctx => store().toggleNodePinned(ctx.node.id),
  },
  {
    id: 'merge-point',
    icon: GitMerge,
    label: ctx => (ctx.isMergePoint ? 'Disable merge point' : 'Enable merge point'),
    show: ctx => ctx.kind === 'note',
    active: ctx => ctx.isMergePoint,
    invoke: ctx => store().toggleNodeMergePoint(ctx.node.id),
  },
  {
    id: 'ancestors',
    icon: Network,
    label: () => 'Context path',
    show: ctx => ctx.kind === 'note',
    active: ctx => (ctx.node.ancestorOverride?.length || 0) > 0,
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      if (a) dialogs().open('ancestors', ctx.node.id, a)
    },
  },
  {
    id: 'tags',
    icon: Tag,
    label: () => 'Manage tags',
    show: ctx => ctx.kind === 'note',
    active: ctx => (ctx.node.tags?.length || 0) > 0,
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      if (a) dialogs().open('tags', ctx.node.id, a)
    },
  },
  {
    id: 'copy-content',
    icon: Copy,
    // Task 4: copy content available on every kind except pure text.
    label: ctx => (ctx.copiedContent ? 'Content copied' : 'Copy content'),
    show: ctx => ctx.kind !== 'text',
    disabled: ctx => !ctx.hasContent,
    // Tint the icon green during the 2s "copied" flash so the quickbar
    // gives visible feedback (the dropdown item also re-labels to
    // "Content copied" via ctx.copiedContent).
    active: ctx => ctx.copiedContent,
    activeClassName: 'text-emerald-500',
    invoke: async ctx => {
      const content = (ctx.node.content as string) || ''
      await copyToClipboard(content)
      // Populate the in-memory paste buffer so the `paste` action on
      // another node can pull this content in. Without this step the
      // OS clipboard has the text but `store.copiedContent` stays null
      // and paste silently no-ops.
      store().setCopiedContent(content)
      toast.success('Content copied')
      ctx.surface.onCopiedContent?.()
    },
  },
  {
    id: 'copy-branch',
    icon: GitBranch,
    label: () => 'Copy branch',
    show: ctx => ctx.kind === 'note',
    invoke: ctx => store().copyBranchText(ctx.node.id),
  },
  {
    id: 'select-children',
    icon: ArrowDownToLine,
    label: () => 'Select children',
    show: ctx => ctx.kind === 'note',
    invoke: ctx => store().selectDescendants(ctx.node.id, true),
  },
  {
    id: 'select-ancestors',
    icon: ArrowUpToLine,
    label: () => 'Select ancestors',
    show: ctx => ctx.kind === 'note',
    invoke: ctx => store().selectAncestors(ctx.node.id, true),
  },
  {
    id: 'paste',
    icon: ClipboardPaste,
    label: () => 'Paste content',
    show: ctx => ctx.kind === 'note',
    // Paste is surface-independent: it reads the app's in-memory copy
    // buffer and writes to this node. No surface callback required, so
    // every node menu exposes it uniformly.
    invoke: ctx => {
      const { copiedContent: clip, updateNodeContent } = store()
      if (!clip) return
      updateNodeContent(ctx.node.id, ctx.node.arrangementId, clip)
    },
  },
  {
    id: 'collapse',
    icon: FolderOpen,
    // Three visually distinct icons so the user can tell the state apart at
    // a glance (folder-manager intuition):
    //   undefined   → FolderOpen   (everything visible)
    //   'recursive' → FolderClosed (subtree hidden)
    //   'single'    → FolderTree   (direct children only)
    iconFor: ctx => {
      if (ctx.collapseState === 'recursive') return FolderClosed
      if (ctx.collapseState === 'single') return FolderTree
      return FolderOpen
    },
    // Label describes the NEXT click:
    //   absent      → "Hide all descendants"
    //   'recursive' → "Show direct children only"
    //   'single'    → "Show all descendants"
    label: ctx => {
      if (ctx.collapseState === 'recursive') return 'Show direct children only'
      if (ctx.collapseState === 'single') return 'Show all descendants'
      return 'Hide all descendants'
    },
    show: ctx => ctx.kind === 'note',
    active: ctx => ctx.isCollapsed,
    invoke: ctx => store().toggleCollapsed(ctx.node.id),
  },
  {
    id: 'duplicate',
    icon: Copy,
    label: () => 'Duplicate',
    // Machines/terminals are stateful infrastructure — "duplicate" would
    // need separate branch/freeze semantics, which are their own actions.
    show: ctx => ctx.kind !== 'machine' && ctx.kind !== 'terminal',
    invoke: ctx => store().duplicateNode(ctx.node.id),
  },
  {
    id: 'branch-machine',
    icon: GitBranch,
    label: ctx => (ctx.isFrozen ? 'Branch from frozen' : 'Branch machine'),
    show: ctx => ctx.kind === 'machine',
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      if (a) dialogs().open('branch', ctx.node.id, a)
      else void store().branchMachine(ctx.node.id)
    },
  },
  {
    id: 'freeze-machine',
    icon: Snowflake,
    label: () => 'Freeze machine',
    show: ctx => ctx.kind === 'machine' && !ctx.isFrozen,
    invoke: ctx => {
      // The card has an inline freeze-naming flow; panels freeze directly.
      if (ctx.surface.onStartFreezeNaming) ctx.surface.onStartFreezeNaming()
      else void store().freezeMachine(ctx.node.id)
    },
  },
  // ---- Machine infra actions (previously hand-rolled in MachineNode/
  //      MachineEditPanel/MissionControlTab). Centralised so a single
  //      change propagates to all three surfaces, and so the user can
  //      pin whichever of them they want on every node's face. --------
  {
    id: 'forward-ports',
    icon: Plug,
    label: ctx => (ctx.isPortActive ? 'Stop forwarding' : 'Forward ports'),
    // Frozen machines have no running services, so the daemon's port
    // detector returns nothing and activation fails — hide to avoid toast.
    show: ctx => ctx.kind === 'machine' && !ctx.isFrozen,
    active: ctx => ctx.isPortActive,
    activeClassName: 'text-emerald-500',
    availableIn: ['canvas', 'mission-control'],
    invoke: ctx => {
      const machineId = (CanvasNode.isInfra(ctx.node) ? ctx.node.machineId : null) || ctx.node.id
      const label = ctx.node.label || undefined
      void useMachineCenterStore.getState().activateForward(machineId, label)
    },
  },
  {
    id: 'create-terminal',
    icon: TerminalSquare,
    label: () => 'New terminal',
    // Canvas-only: spawns a new TERMINAL node next to the machine on
    // reactflow, which only exists in the canvas store.
    show: ctx => ctx.kind === 'machine' && !ctx.isFrozen,
    availableIn: ['canvas'],
    invoke: ctx => void store().createTerminal(ctx.node.id),
  },
  {
    id: 'open-windsurf',
    icon: Code,
    label: () => 'Open in Windsurf',
    show: ctx => ctx.kind === 'machine' && !ctx.isFrozen,
    availableIn: ['canvas', 'mission-control'],
    invoke: ctx => openInIDE(ctx, 'windsurf'),
  },
  {
    id: 'open-vscode',
    icon: Code,
    label: () => 'Open in VS Code',
    show: ctx => ctx.kind === 'machine' && !ctx.isFrozen,
    availableIn: ['canvas', 'mission-control'],
    invoke: ctx => openInIDE(ctx, 'vscode'),
  },
  {
    id: 'open-cursor',
    icon: Code,
    label: () => 'Open in Cursor',
    show: ctx => ctx.kind === 'machine' && !ctx.isFrozen,
    availableIn: ['canvas', 'mission-control'],
    invoke: ctx => openInIDE(ctx, 'cursor'),
  },
  {
    id: 'copy-ssh',
    icon: Copy,
    label: () => 'Copy SSH command',
    show: ctx => ctx.kind === 'machine' && !ctx.isFrozen,
    availableIn: ['canvas', 'mission-control'],
    invoke: async ctx => {
      const machineId = (CanvasNode.isInfra(ctx.node) ? ctx.node.machineId : null) || ctx.node.id
      const result = await DaemonService.sshInfo(machineId)
      if ('success' in result) {
        await copyToClipboard(result.success.command)
        toast.success('SSH command copied to clipboard')
        return
      }
      toast.error(result.error.message || 'IDE not available for this machine.')
    },
  },
  {
    id: 'cache',
    icon: Database,
    label: () => 'Cache branch',
    // Cache anchors are per-model on user/assistant/system notes. Machines
    // and terminals never participate in the LLM cache flow.
    show: ctx => ctx.kind === 'note',
    active: ctx => {
      const model = store().selectedModel
      return !!Note.CacheConfig.get(ctx.node.cacheConfig, model as string)?.enabled
    },
    // Colour-only; a fill would flood the disk-ring strokes into a solid blob.
    activeClassName: 'text-emerald-600',
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      if (a) dialogs().open('cache', ctx.node.id, a)
    },
  },
  {
    id: 'info',
    icon: Info,
    label: () => 'Info',
    // Only notes can have run info (token usage + cost per run).
    show: ctx => ctx.kind === 'note',
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      // anchor is unused by the modal Dialog; pass a zeroed rect so the
      // store's open() contract stays satisfied.
      dialogs().open('info', ctx.node.id, a ?? { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
    },
  },
  {
    id: 'run-workflow',
    icon: WorkflowIcon,
    label: () => 'Run workflow…',
    // Same eligibility as Run Action: only content notes can be a workflow target.
    show: ctx => ctx.kind === 'note',
    invoke: (ctx, trigger) => {
      const a = trigger ? anchorFromEvent(trigger) : null
      if (a) dialogs().open('workflow', ctx.node.id, a)
    },
  },
  {
    id: 'delete',
    icon: Trash2,
    label: () => 'Delete',
    show: () => true,
    destructive: true,
    invoke: ctx => store().deleteNode(ctx.node.id),
  },
]

// ============================================================
// Hook + component
// ============================================================

/**
 * Build a `NodeActionCtx` from a node and a surface. Memoised so child
 * actions don't re-derive flags on every render.
 */
export function useNodeActionCtx(
  node: CanvasNode.UI | null | undefined,
  surface: NodeActionSurface,
  signals: { copiedContent?: boolean; surfaceType?: SurfaceType } = {}
): NodeActionCtx | null {
  const kind = node ? classifyNode(node.type as Note.Type | undefined) : null
  const shouldTrackCollapse = !!node && kind === 'note'
  const shouldTrackPortForward = !!node && kind === 'machine'

  // Hook must run unconditionally — selector safely returns false when
  // node is missing and callers bail out via the null return below.
  const isCollapsed = useCanvasStore(state => (shouldTrackCollapse ? state.collapsedNodeIds.has(node.id) : false))
  const collapseState = useCanvasStore(state => (shouldTrackCollapse ? state.collapseStates.get(node.id) : undefined))
  // Derived from the global port-forward slice. Subscribing here means
  // every action-bearing surface (cards, panels, Mission Control rows)
  // live-updates when forwarding switches machines.
  const activeForwardMachineId = useMachineCenterStore(s => (shouldTrackPortForward ? (s.activeForward?.machineId ?? null) : null))
  return useMemo<NodeActionCtx | null>(() => {
    if (!node || !kind) return null
    const machineId = (CanvasNode.isInfra(node) ? node.machineId : null) || node.id
    return {
      node,
      kind,
      isFrozen: (node.status as string) === 'FROZEN',
      isPinned: !!node.pinned,
      isMergePoint: !!node.isMergePoint,
      isCollapsed,
      collapseState,
      hasContent: (node.content || '').trim().length > 0,
      isPortActive: activeForwardMachineId === machineId,
      copiedContent: !!signals.copiedContent,
      surface,
      surfaceType: signals.surfaceType ?? 'canvas',
    }
  }, [node, kind, isCollapsed, collapseState, activeForwardMachineId, surface, signals.copiedContent, signals.surfaceType])
}

/**
 * Resolves the visible + pinned action sets for a ctx. Both the menu and
 * the quick-bar need the same filtering, and both need to share the same
 * pinned-id source so toggling a pin in one surface is reflected in the
 * other immediately (the store is global, so this is automatic).
 */
function useVisibleActions(ctx: NodeActionCtx | null) {
  const pinnedToolIds = usePinnedToolsStore(s => s.pinnedToolIds)
  const togglePinnedTool = usePinnedToolsStore(s => s.toggle)
  // Surface-filter first (cheap), then per-action show() which inspects
  // node state. Actions that don't declare availableIn default to canvas.
  const visible = ctx
    ? NODE_ACTIONS.filter(a => {
        const surfaces = a.availableIn ?? ['canvas']
        return surfaces.includes(ctx.surfaceType) && a.show(ctx)
      })
    : []
  const pinned = visible.filter(a => pinnedToolIds.includes(a.id))
  return { visible, pinned, pinnedToolIds, togglePinnedTool }
}

/**
 * Renders the full, kind-filtered set of actions as a standard dropdown.
 * Works identically inside card 3-dot menus and edit panel headers.
 *
 * `pinnable` — render a small pin sidecar per item so users can toggle
 * which actions show up in <NodeActionsQuickBar>. Pinning state is global
 * (usePinnedToolsStore) so every surface reflects the same set.
 */
export function NodeActionsMenu({
  ctx,
  trigger,
  align = 'end',
  className,
  pinnable = true,
}: {
  ctx: NodeActionCtx | null
  trigger?: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
  pinnable?: boolean
}) {
  const { visible, pinnedToolIds, togglePinnedTool } = useVisibleActions(ctx)
  if (!ctx) return null
  // No actions → no trigger. Happens e.g. for a frozen machine viewed
  // from Mission Control: every registry action gated by `!isFrozen` is
  // filtered out, and we'd otherwise render a dead 3-dot button.
  if (visible.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
        {trigger ?? (
          <button
            type="button"
            aria-label="Node actions"
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-black/5 hover:text-slate-800',
              className
            )}
            onClick={e => e.stopPropagation()}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[220px]" onClick={e => e.stopPropagation()}>
        {visible.map(a => {
          const disabled = a.disabled?.(ctx) ?? false
          const isActive = a.active?.(ctx) ?? false
          const Icon = a.iconFor ? a.iconFor(ctx) : a.icon
          // If an action provides its own active class (e.g. cache wants
          // colour-only green without a fill flood), use it on BOTH the
          // item and its icon so the colour reads at a glance. Otherwise
          // fall back to the default bold treatment.
          const hasCustomActive = isActive && !!a.activeClassName
          const activeClass = isActive ? (a.activeClassName ?? 'font-semibold') : undefined
          const isPinned = pinnedToolIds.includes(a.id)
          return (
            <DropdownMenuItem
              key={a.id}
              disabled={disabled}
              onClick={e => {
                e.stopPropagation()
                void a.invoke(ctx, e)
              }}
              className={cn('flex items-center justify-between gap-2', a.destructive && 'text-red-600', activeClass)}
            >
              <div className="flex items-center gap-2">
                <Icon className={cn('h-4 w-4', hasCustomActive && a.activeClassName)} />
                {a.label(ctx)}
              </div>
              {pinnable && !a.destructive && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    e.preventDefault()
                    togglePinnedTool(a.id)
                  }}
                  className="rounded p-0.5 hover:bg-gray-200"
                  title={isPinned ? 'Unpin from toolbar' : 'Pin to toolbar'}
                >
                  {isPinned ? <Pin className="h-3 w-3 fill-current text-blue-600" /> : <PinOff className="h-3 w-3 text-gray-400" />}
                </button>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Renders the pinned subset of actions as a row of icon buttons. Meant to
 * sit next to the 3-dot menu on a node's face as quick-access shortcuts.
 * Respects kind filtering — actions that don't apply to the node's kind
 * are silently skipped, even if pinned globally.
 *
 * `darkTheme` — tune colours for dark (ASSISTANT) node backgrounds.
 */
export function NodeActionsQuickBar({
  ctx,
  darkTheme = false,
  buttonClassName,
}: {
  ctx: NodeActionCtx | null
  darkTheme?: boolean
  buttonClassName?: string
}) {
  const { pinned } = useVisibleActions(ctx)
  if (!ctx || pinned.length === 0) return null
  // Width is bounded by the CALL SITE (NoteCard / MachineNode wrap this in
  // a max-w-[60%] container measured against the card header). The bar
  // itself just lays its buttons out and wraps downward when constrained,
  // so the constraint reads as "60% of the card width", not "60% of an
  // arbitrary content-sized parent".
  return (
    <div className="flex flex-wrap items-center justify-end gap-0.5">
      {pinned.map(a => {
        const disabled = a.disabled?.(ctx) ?? false
        const isActive = a.active?.(ctx) ?? false
        const Icon = a.iconFor ? a.iconFor(ctx) : a.icon
        const hasCustomActive = isActive && !!a.activeClassName
        return (
          <button
            key={a.id}
            type="button"
            disabled={disabled}
            onClick={e => {
              e.stopPropagation()
              void a.invoke(ctx, e)
            }}
            title={a.label(ctx)}
            className={cn(
              'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md p-0 disabled:opacity-40',
              darkTheme ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-black/5',
              buttonClassName
            )}
          >
            <Icon
              className={cn(
                'h-3.5 w-3.5',
                // Custom active class wins (e.g. cache = text-emerald-600).
                // Otherwise the default active tint is a subtle blue.
                hasCustomActive ? a.activeClassName : isActive && (darkTheme ? 'text-blue-300' : 'text-blue-600')
              )}
            />
          </button>
        )
      })}
    </div>
  )
}
