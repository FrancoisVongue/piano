'use client'

/**
 * Single source of truth for React Flow handles on canvas nodes.
 *
 * Why this exists:
 *   We had 8 identical `<Handle className="!w-4 !h-4 !bg-... !z-10 ..." />`
 *   incantations scattered across NoteCard (×4), MachineNode (×2),
 *   TerminalNode (×2). Every time we tuned sizing, colour, or — most
 *   importantly — forgot `!z-10`, half the canvas would get clipped
 *   handles and we'd play whack-a-mole across four files.
 *
 * Contract:
 *   - Always renders target (top) + source (bottom) unless `only` is set.
 *   - `!z-10` is load-bearing: it's what lets handles escape the
 *     OUTER/INNER clipping pattern used by every node type. Do NOT
 *     remove it from the base classes; if a specific node needs a
 *     different stacking context, pass it via `className`.
 *   - B&W-only styling per DESIGN.md pivot (no emerald / cyan).
 *     White dot with a black ring reads on every surface we ship:
 *     white paper (user notes), dark paper (assistant), black
 *     chassis (machine / terminal).
 */

import { Handle, Position } from '@xyflow/react'
import { cn } from '@/lib/utils'

const BASE_CLASSES =
  '!w-4 !h-4 !bg-white !border-2 !border-black !rounded-sm !z-10 transition-colors'

interface NodeHandlesProps {
  /**
   * Render only one side. Default: both target (top) and source (bottom).
   * Rarely needed — most nodes are both endpoints of a graph edge — but
   * e.g. a terminal leaf or a root injection node might want just one.
   */
  only?: 'top' | 'bottom'
  /** Extra classes merged onto every rendered handle. */
  className?: string
}

export function NodeHandles({ only, className }: NodeHandlesProps = {}) {
  return (
    <>
      {only !== 'bottom' && (
        <Handle
          type="target"
          position={Position.Top}
          className={cn(BASE_CLASSES, className)}
        />
      )}
      {only !== 'top' && (
        <Handle
          type="source"
          position={Position.Bottom}
          className={cn(BASE_CLASSES, className)}
        />
      )}
    </>
  )
}
