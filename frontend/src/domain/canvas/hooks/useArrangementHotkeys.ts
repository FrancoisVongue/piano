import { useEffect, useMemo } from 'react'
import { Arrangement, LLM, Note } from '@piano/shared'
import { toast } from 'sonner'
import { useCanvasStore } from '../store'
import { useActiveModels } from '@/domain/settings/hooks/useSettings'
import { useActionsContext } from '@/domain/action/ActionsContext'
import { isTypingTarget } from '@/lib/keyboard'
import { partitionByVisibility } from '@/lib/visibilityOrder'
import { confirmBulkAction } from '@/domain/action/lib/confirmBulkAction'

// Match physical keys via `e.code` rather than the produced character via
// `e.key`. e.key flips with keyboard layouts (Russian: q→й) and macOS Option
// (Option+letter → typographic char). e.code reports the QWERTY physical
// position no matter what — exactly what we want for spatial home-row
// hotkeys, which the user picked for ergonomics, not for the letter shape.
const MODEL_CODES = ['KeyQ', 'KeyW', 'KeyE', 'KeyR'] as const
const ACTION_CODES = ['KeyA', 'KeyS', 'KeyD', 'KeyF'] as const
const labelOf = (code: string) => code.slice(3).toLowerCase()

interface Args {
  arrangement: Arrangement.Model | null
}

/**
 * Arrangement-level hotkeys that are LIST-driven, not function-named:
 *   q w e r → setSelectedModel(visibleModels[0..3])    (passive, picks model)
 *   a s d f → run visibleActions[0..3] on selected actionable nodes (active)
 *
 * "Visible / order" is whatever the user dragged into the top 4 slots in
 * ModelSelector / OperationsButton — same source of truth, no separate
 * pin registry. The numeric workspaces (1..9) live in useWorkspaces; this
 * hook only owns the letter row.
 */
export function useArrangementHotkeys({ arrangement }: Args) {
  const setSelectedModel = useCanvasStore(state => state.setSelectedModel)
  const runNode = useCanvasStore(state => state.runNode)
  const { models: allModels } = useActiveModels()
  const { actions: visibleActions } = useActionsContext()

  const visibleModels = useMemo(
    () => partitionByVisibility(allModels, arrangement?.config?.models?.visibleIds).visible,
    [allModels, arrangement?.config?.models?.visibleIds],
  )

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return

      // Alt + letter = "act of intent" across the arrangement system. Bare
      // letters are reserved for navigation (e.g. workspace jump 1..9) and
      // future single-key features; switching model / running action both
      // commit something the user really means, so we require the modifier.
      if (!e.altKey || e.metaKey || e.ctrlKey) return

      const modelIdx = (MODEL_CODES as readonly string[]).indexOf(e.code)
      const actionIdx = (ACTION_CODES as readonly string[]).indexOf(e.code)
      if (modelIdx < 0 && actionIdx < 0) return

      e.preventDefault()
      e.stopPropagation()

      const label = labelOf(e.code)

      if (modelIdx >= 0) {
        const target = visibleModels[modelIdx]
        if (!target) {
          toast.info(`No model bound to Alt+${label} — drag one into top ${modelIdx + 1} in the model picker`)
          return
        }
        setSelectedModel(target.id as LLM.ModelId)
        toast.success(`Model: ${target.name}`)
        return
      }

      // Action invocation — fan out across actionable selected nodes.
      const action = visibleActions[actionIdx]
      if (!action) {
        toast.info(`No action bound to Alt+${label} — drag one into top ${actionIdx + 1} in Actions`)
        return
      }
      const nodes = useCanvasStore.getState().nodes
      const targetIds = nodes
        .filter(n => n.selected && Note.capabilities(n.data as { type?: Note.Type } | undefined).canRunAction)
        .map(n => n.id)
      if (targetIds.length === 0) {
        toast.info(`Select a node first — Alt+${label} runs ${action.name} on selection`)
        return
      }

      const proceed = await confirmBulkAction({ actionName: action.name, count: targetIds.length })
      if (!proceed) return

      let ok = 0
      let failed = 0
      await Promise.all(targetIds.map(async (nodeId) => {
        try {
          await runNode(nodeId, action.id)
          ok++
        } catch (err) {
          failed++
          console.error('[hotkey-action] runNode failed', { nodeId, actionId: action.id, err })
        }
      }))
      if (ok > 0) toast.success(`${action.name} → ${ok} node${ok === 1 ? '' : 's'}`)
      if (failed > 0) toast.error(`${action.name} failed on ${failed} node${failed === 1 ? '' : 's'}`)
    }

    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [visibleModels, visibleActions, setSelectedModel, runNode])
}
