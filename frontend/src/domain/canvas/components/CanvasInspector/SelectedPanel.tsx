'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckSquare,
  Play,
  Combine,
  Tag as TagIcon,
  Palette,
  Type as TypeIcon,
  Scaling,
  Shrink,
  Copy,
  Trash2,
  Link as LinkIcon,
  Layers as LayersIcon,
  CornerDownRight,
  ArrowDownUp,
  ArrowLeftRight,
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
  Grid3x3,
  StretchHorizontal,
  StretchVertical,
  X,
  XCircle,
} from 'lucide-react'
import { areNodesStructurallyEqual, useCanvasStore, useCanvasStoreEq } from '../../store'
import { ReactFlowInstance } from '@xyflow/react'
import { useActionsContext } from '@/domain/action/ActionsContext'
import { useUnifiersStore } from '@/domain/unifier/store'
import { ArrangementService } from '@/domain/arrangement/services'
import { Union } from '@/lib/types'
import { Note } from '@piano/shared'
import { toast } from 'sonner'
import { confirmBulkAction } from '@/domain/action/lib/confirmBulkAction'
import { Analytics } from '@/lib/analytics'
import { sortNodesByReadingOrder } from '../../lib/reading-order'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { InspectorColumn, InspectorRow } from './InspectorColumn'

interface SelectedPanelProps {
  reactFlowInstance: ReactFlowInstance | null
  onStartSetParent: (nodeIds: string[]) => void
  onAfterFocus?: () => void
}

const SCALE_MIN = 0.1
const SCALE_MAX = 10
const LN_SCALE_MIN = Math.log(SCALE_MIN)
const LN_SCALE_RANGE = Math.log(SCALE_MAX) - LN_SCALE_MIN
const SCALE_SLIDER_STEP = 0.002
const sliderToScale = (s: number) => Math.exp(LN_SCALE_MIN + s * LN_SCALE_RANGE)
const scaleToSlider = (v: number) => (Math.log(v) - LN_SCALE_MIN) / LN_SCALE_RANGE
const quantizeScale = (v: number) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100))

const SPACING_MIN = 0.2
const SPACING_MAX = 5
const LN_SPACING_MIN = Math.log(SPACING_MIN)
const LN_SPACING_RANGE = Math.log(SPACING_MAX) - LN_SPACING_MIN
const sliderToSpacing = (s: number) => Math.exp(LN_SPACING_MIN + s * LN_SPACING_RANGE)
const spacingToSlider = (v: number) => (Math.log(v) - LN_SPACING_MIN) / LN_SPACING_RANGE

const COLORS = [
  { name: 'Blue', bg: 'bg-blue-50', border: 'border-blue-300' },
  { name: 'Green', bg: 'bg-green-50', border: 'border-green-300' },
  { name: 'Pink', bg: 'bg-pink-50', border: 'border-pink-300' },
  { name: 'Yellow', bg: 'bg-yellow-50', border: 'border-yellow-300' },
  { name: 'Indigo', bg: 'bg-indigo-50', border: 'border-indigo-300' },
  { name: 'Slate', bg: 'bg-slate-100', border: 'border-slate-400' },
] as const

type InlineForm = null | 'label' | 'tags' | 'color' | 'layers' | 'sort'

export function SelectedPanel({ reactFlowInstance, onStartSetParent, onAfterFocus }: SelectedPanelProps) {
  const nodes = useCanvasStoreEq(state => state.nodes, areNodesStructurallyEqual)
  const arrangementId = useCanvasStore(state => state.arrangementId)
  const selectedModel = useCanvasStore(state => state.selectedModel)
  const runNode = useCanvasStore(state => state.runNode)
  const bulkUpdateLabel = useCanvasStore(state => state.bulkUpdateLabel)
  const bulkAddTags = useCanvasStore(state => state.bulkAddTags)
  const bulkUpdateColor = useCanvasStore(state => state.bulkUpdateColor)
  const bulkUpdateScale = useCanvasStore(state => state.bulkUpdateScale)
  const bulkUpdateLayers = useCanvasStore(state => state.bulkUpdateLayers)
  const activeLayer = useCanvasStore(state => state.activeLayer)
  const storeKnownLayers = useCanvasStore(state => state.knownLayers)
  const pushHistory = useCanvasStore(state => state.pushHistory)
  const compactCanvas = useCanvasStore(state => state.compactCanvas)
  const copySelectedNodesAsText = useCanvasStore(state => state.copySelectedNodesAsText)
  const deleteNode = useCanvasStore(state => state.deleteNode)
  const addNodes = useCanvasStore(state => state.addNodes)
  const connectSelected = useCanvasStore(state => state.connectSelected)
  const autoLayout = useCanvasStore(state => state.autoLayout)
  const alignSelection = useCanvasStore(state => state.alignSelection)
  const onNodesChange = useCanvasStore(state => state.onNodesChange)
  const { actions } = useActionsContext()
  const unifiers = useUnifiersStore(state => state.unifiers)

  const [openForm, setOpenForm] = useState<InlineForm>(null)
  const [labelInput, setLabelInput] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [layersInput, setLayersInput] = useState('')
  const [scaleValue, setScaleValue] = useState(1.0)
  const [compactValue, setCompactValue] = useState(1.0)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const scaleReferenceRef = useRef<{
    scale: number
    positions: Record<string, { x: number; y: number }>
  } | null>(null)
  const scaleDragStartedRef = useRef(false)
  const compactReferenceRef = useRef<Record<string, { x: number; y: number }> | null>(null)
  const compactValueRef = useRef(1.0)

  // Two-step delete: first click arms, second click commits. Auto-disarm after
  // a short window so a stray click doesn't sit waiting to delete forever.
  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(false), 3500)
    return () => clearTimeout(t)
  }, [confirmDelete])

  const selectedNodes = useMemo(() => sortNodesByReadingOrder(nodes.filter(n => n.selected === true)), [nodes])
  const selectedNodeIds = useMemo(() => selectedNodes.map(n => n.id), [selectedNodes])

  const actionableNodeIds = useMemo(
    () =>
      sortNodesByReadingOrder(
        nodes.filter(n => n.selected === true && Note.capabilities(n.data as { type?: Note.Type } | undefined).canRunAction)
      ).map(n => n.id),
    [nodes]
  )

  const unifiableNodeIds = useMemo(
    () =>
      sortNodesByReadingOrder(
        nodes.filter(n => n.selected === true && Note.capabilities(n.data as { type?: Note.Type } | undefined).canBeUnifierSource)
      ).map(n => n.id),
    [nodes]
  )

  useEffect(() => {
    if (scaleDragStartedRef.current) return
    if (selectedNodeIds.length === 0) return
    const sel = nodes.filter(n => selectedNodeIds.includes(n.id))
    if (sel.length === 0) return
    const avg = sel.reduce((s, n) => s + ((n.data.scale as number) ?? 1), 0) / sel.length
    setScaleValue(avg)
  }, [selectedNodeIds, nodes])

  const focusNode = useCallback(
    (nodeId: string, fallbackPosition: { x: number; y: number }, fallbackScale: number = 1) => {
      if (!reactFlowInstance) return
      const liveNode = useCanvasStore.getState().nodes.find(n => n.id === nodeId)
      const position = liveNode?.position ?? fallbackPosition
      const scale = ((liveNode?.data.scale as number | undefined) ?? fallbackScale) || 1
      const zoom = Math.min(3, Math.max(0.5, 1.2 / (scale * scale)))
      reactFlowInstance.setCenter(position.x, position.y, { duration: 800, zoom })
      onAfterFocus?.()
    },
    [reactFlowInstance, onAfterFocus]
  )

  const getDisplayText = useCallback((label: string | null, content: string) => {
    if (label?.trim()) return label
    const trimmed = content?.trim() || ''
    if (trimmed.length === 0) return '(Empty note)'
    return trimmed.length > 36 ? trimmed.slice(0, 36) + '…' : trimmed
  }, [])

  const handleClearSelection = useCallback(() => {
    const changes = selectedNodeIds.map(id => ({ id, type: 'select' as const, selected: false }))
    if (changes.length) onNodesChange(changes)
  }, [selectedNodeIds, onNodesChange])

  const handleRunActionForEach = useCallback(
    async (actionId: string) => {
      const action = actions.find(a => a.id === actionId)
      const proceed = await confirmBulkAction({
        actionName: action?.name ?? 'action',
        count: actionableNodeIds.length,
      })
      if (!proceed) return
      let ok = 0,
        fail = 0
      for (const id of actionableNodeIds) {
        try {
          await runNode(id, actionId)
          ok++
        } catch {
          fail++
        }
      }
      if (ok) toast.success(`Action completed for ${ok} node${ok !== 1 ? 's' : ''}`)
      if (fail) toast.error(`Failed for ${fail} node${fail !== 1 ? 's' : ''}`)
    },
    [actions, actionableNodeIds, runNode]
  )

  const handleRunUnifier = useCallback(
    async (unifierId: string) => {
      if (!arrangementId) return
      const result = await ArrangementService.executeUnifier(arrangementId, unifierId, {
        noteIds: unifiableNodeIds,
        model: selectedModel,
      })
      Union.match(
        {
          success: data => {
            Analytics.track('unifier_run_started', {
              arrangementId,
              unifierId,
              selectedNoteCount: unifiableNodeIds.length,
              model: selectedModel,
              hasUserPrompt: false,
            })
            if (data.responseNode) {
              addNodes([data.responseNode])
              toast.success('Unifier executed')
            }
          },
          error: err => toast.error(err.message),
        },
        result
      )
    },
    [arrangementId, unifiableNodeIds, selectedModel, addNodes]
  )

  const handleSetLabel = useCallback(() => {
    const trimmed = labelInput.trim()
    bulkUpdateLabel(selectedNodeIds, trimmed === '' ? null : trimmed)
    toast.success(`Label ${trimmed ? 'set' : 'cleared'} for ${selectedNodeIds.length} node${selectedNodeIds.length !== 1 ? 's' : ''}`)
    setLabelInput('')
    setOpenForm(null)
  }, [selectedNodeIds, labelInput, bulkUpdateLabel])

  const handleAddTags = useCallback(() => {
    const tags = tagsInput
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
    if (tags.length > 0) {
      bulkAddTags(selectedNodeIds, tags)
      toast.success(`Tags added to ${selectedNodeIds.length} node${selectedNodeIds.length !== 1 ? 's' : ''}`)
    }
    setTagsInput('')
    setOpenForm(null)
  }, [selectedNodeIds, tagsInput, bulkAddTags])

  const handleSetColor = useCallback(
    (c: { bg: string; border: string } | null) => {
      const v = c ? `${c.bg}|${c.border}` : null
      bulkUpdateColor(selectedNodeIds, v)
      toast.success(`Color ${v ? 'set' : 'cleared'}`)
      setOpenForm(null)
    },
    [selectedNodeIds, bulkUpdateColor]
  )

  // Move selected nodes to a layer set. `override` lets the chip-style "→ active"
  // / "→ global" buttons skip the text input. Replace semantics — empty array =
  // global ("lives on every layer").
  const handleSetLayers = useCallback(
    (override?: string[]) => {
      const fromInput = layersInput
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
      const layers = override ?? fromInput
      bulkUpdateLayers(selectedNodeIds, layers)
      toast.success(
        layers.length === 0
          ? `Moved ${selectedNodeIds.length} node${selectedNodeIds.length !== 1 ? 's' : ''} to global`
          : `Moved ${selectedNodeIds.length} node${selectedNodeIds.length !== 1 ? 's' : ''} to ${layers.join(', ')}`
      )
      setLayersInput('')
      setOpenForm(null)
    },
    [selectedNodeIds, layersInput, bulkUpdateLayers]
  )

  // Union of the store's intent set (layers typed via LayerBar or moved-onto
  // via bulk action) with what's currently on disk — so the chip list shows
  // both freshly-named layers and ones that arrived through sync/import.
  const knownLayers = useMemo(() => {
    const fromNotes = Note.Layers.collectKnown(nodes.map(n => n.data as { layers?: string[] | null }))
    const merged = new Set<string>(fromNotes)
    for (const l of storeKnownLayers) merged.add(l)
    return [...merged].sort()
  }, [nodes, storeKnownLayers])

  const handleConnectSelected = useCallback(() => {
    if (selectedNodeIds.length < 2) {
      toast.info('Select at least two nodes to connect')
      return
    }
    const created = connectSelected(selectedNodeIds)
    if (created > 0) toast.success(`Connected ${created + 1} nodes`)
  }, [connectSelected, selectedNodeIds])

  const handleDeleteSelected = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    const count = selectedNodeIds.length
    selectedNodeIds.forEach(id => deleteNode(id))
    setConfirmDelete(false)
    setOpenForm(null)
    toast.success(`Deleted ${count} node${count !== 1 ? 's' : ''}`)
  }, [confirmDelete, deleteNode, selectedNodeIds])

  const handleScaleStart = useCallback(() => {
    if (scaleDragStartedRef.current) return
    scaleDragStartedRef.current = true
    const positions: Record<string, { x: number; y: number }> = {}
    const liveNodes = useCanvasStore.getState().nodes
    for (const id of selectedNodeIds) {
      const node = liveNodes.find(n => n.id === id)
      if (node) positions[id] = { x: node.position.x, y: node.position.y }
    }
    scaleReferenceRef.current = { scale: scaleValue, positions }
    pushHistory()
  }, [selectedNodeIds, scaleValue, pushHistory])

  const handleScaleChange = useCallback(
    (vals: number[]) => {
      const next = quantizeScale(sliderToScale(vals[0]))
      setScaleValue(next)
      // Apply live so nodes scale together with the slider, not only on release.
      // onPointerDown sets the reference; keyboard interaction skips it, so seed
      // it here. Transient = no history/dirty/timestamp churn during the drag;
      // handleScaleCommit does the final non-transient apply.
      if (!scaleReferenceRef.current) handleScaleStart()
      const ref = scaleReferenceRef.current
      bulkUpdateScale(selectedNodeIds, next, {
        transient: true,
        ...(ref ? { referenceScale: ref.scale, referencePositions: ref.positions } : {}),
      })
    },
    [bulkUpdateScale, selectedNodeIds, handleScaleStart]
  )

  const handleScaleCommit = useCallback(
    (vals?: number[]) => {
      const final = vals ? quantizeScale(sliderToScale(vals[0])) : scaleValue
      const ref = scaleReferenceRef.current
      bulkUpdateScale(selectedNodeIds, final, {
        skipHistoryBefore: scaleDragStartedRef.current,
        ...(ref ? { referenceScale: ref.scale, referencePositions: ref.positions } : {}),
      })
      scaleReferenceRef.current = null
      scaleDragStartedRef.current = false
    },
    [bulkUpdateScale, scaleValue, selectedNodeIds]
  )

  const handleCompactStart = useCallback(() => {
    const positions: Record<string, { x: number; y: number }> = {}
    const liveNodes = useCanvasStore.getState().nodes
    for (const id of selectedNodeIds) {
      const node = liveNodes.find(n => n.id === id)
      if (node) positions[id] = { x: node.position.x, y: node.position.y }
    }
    compactReferenceRef.current = positions
  }, [selectedNodeIds])

  const handleCompactEnd = useCallback(() => {
    if (compactReferenceRef.current) {
      compactCanvas(compactValueRef.current, compactReferenceRef.current, selectedNodeIds)
    }
    compactReferenceRef.current = null
    compactValueRef.current = 1.0
    setCompactValue(1.0)
  }, [compactCanvas, selectedNodeIds])

  const handleCompactChange = useCallback(
    (vals: number[]) => {
      const v = sliderToSpacing(vals[0])
      compactValueRef.current = v
      setCompactValue(v)
      if (!compactReferenceRef.current) handleCompactStart()
      compactCanvas(v, compactReferenceRef.current || undefined, selectedNodeIds, { transient: true })
    },
    [compactCanvas, selectedNodeIds, handleCompactStart]
  )

  const handleSort = useCallback(
    (dir: 'LR' | 'TB') => {
      autoLayout(dir, selectedNodeIds.length > 0 ? selectedNodeIds : undefined)
      setOpenForm(null)
    },
    [autoLayout, selectedNodeIds]
  )

  const handleAlign = useCallback(
    (kind: 'horizontal-line' | 'vertical-line' | 'grid' | 'distribute-h' | 'distribute-v') => {
      alignSelection(kind)
      setOpenForm(null)
    },
    [alignSelection]
  )

  return (
    <InspectorColumn
      icon={<CheckSquare className="h-3 w-3" />}
      accent="text-emerald-600"
      title="Selected"
      count={selectedNodes.length}
      width={340}
      headerExtra={
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-stone-100"
            onClick={() => {
              void copySelectedNodesAsText()
            }}
            title="Copy selected text"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-stone-100"
            onClick={handleClearSelection}
            title="Clear selection"
          >
            <XCircle className="h-3 w-3" />
          </button>
        </div>
      }
    >
      {/* Actions + Unifiers — two side-by-side stacks. Now that Selected is
          340px wide, each stack gets ~160px which is enough for action names. */}
      {(actions.length > 0 || unifiers.length > 0) && (
        <div className="border-b border-stone-200 bg-stone-50/40">
          <div className="grid grid-cols-2 divide-x divide-stone-200">
            <SubBlock icon={<Play className="h-3 w-3 text-amber-500" />} title="Actions" count={actionableNodeIds.length}>
              {actions.length === 0 && <Empty>None defined</Empty>}
              {actions.length > 0 && actionableNodeIds.length === 0 && <Empty>Not actionable</Empty>}
              {actions.length > 0 &&
                actionableNodeIds.length > 0 &&
                actions.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => handleRunActionForEach(a.id)}
                    className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[11px] text-gray-700 transition-colors hover:bg-amber-50 hover:text-amber-700"
                  >
                    <Play className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{a.name}</span>
                  </button>
                ))}
            </SubBlock>
            <SubBlock icon={<Combine className="h-3 w-3 text-indigo-500" />} title="Unifiers" count={unifiableNodeIds.length}>
              {unifiers.length === 0 && <Empty>None defined</Empty>}
              {unifiers.length > 0 && unifiableNodeIds.length === 0 && <Empty>Not unifiable</Empty>}
              {unifiers.length > 0 &&
                unifiableNodeIds.length > 0 &&
                unifiers.map(u => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => handleRunUnifier(u.id)}
                    className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[11px] text-gray-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
                  >
                    <Combine className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{u.name}</span>
                  </button>
                ))}
            </SubBlock>
          </div>
        </div>
      )}

      {/* Bulk operations. 4 cols × 2 rows = 8 cells. Layer slots next to the
          other property-edits (Label / Tags / Color) — it acts on the same
          shape (node metadata, replace semantics). */}
      <div className="grid grid-cols-4 border-b border-stone-200 bg-stone-100/60">
        <BulkButton
          icon={<TypeIcon className="h-3 w-3" />}
          label="Label"
          active={openForm === 'label'}
          onClick={() => setOpenForm(openForm === 'label' ? null : 'label')}
        />
        <BulkButton
          icon={<TagIcon className="h-3 w-3" />}
          label="Tags"
          active={openForm === 'tags'}
          onClick={() => setOpenForm(openForm === 'tags' ? null : 'tags')}
        />
        <BulkButton
          icon={<Palette className="h-3 w-3" />}
          label="Color"
          active={openForm === 'color'}
          onClick={() => setOpenForm(openForm === 'color' ? null : 'color')}
        />
        <BulkButton
          icon={<LayersIcon className="h-3 w-3" />}
          label="Layer"
          active={openForm === 'layers'}
          onClick={() => setOpenForm(openForm === 'layers' ? null : 'layers')}
        />
        <BulkButton
          icon={<LinkIcon className="h-3 w-3" />}
          label="Connect"
          disabled={selectedNodeIds.length < 2}
          onClick={handleConnectSelected}
        />
        <BulkButton icon={<CornerDownRight className="h-3 w-3" />} label="Parent" onClick={() => onStartSetParent(selectedNodeIds)} />
        <BulkButton
          icon={<ArrowDownUp className="h-3 w-3" />}
          label="Sort"
          active={openForm === 'sort'}
          onClick={() => setOpenForm(openForm === 'sort' ? null : 'sort')}
        />
      </div>

      {/* Inline forms — replace popup dialogs */}
      {openForm === 'label' && (
        <InlinePanel title="Set label" onCancel={() => setOpenForm(null)}>
          <Input
            value={labelInput}
            onChange={e => setLabelInput(e.target.value)}
            placeholder="Label (empty to clear)"
            onKeyDown={e => {
              if (e.key === 'Enter') handleSetLabel()
              if (e.key === 'Escape') setOpenForm(null)
            }}
            className="h-7 text-xs"
            autoFocus
          />
          <Button size="sm" className="h-7 w-full text-xs" onClick={handleSetLabel}>
            Apply to {selectedNodeIds.length}
          </Button>
        </InlinePanel>
      )}
      {openForm === 'tags' && (
        <InlinePanel title="Add tags" onCancel={() => setOpenForm(null)}>
          <Input
            value={tagsInput}
            onChange={e => setTagsInput(e.target.value)}
            placeholder="tag1, tag2, tag3"
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddTags()
              if (e.key === 'Escape') setOpenForm(null)
            }}
            className="h-7 text-xs"
            autoFocus
          />
          <Button size="sm" className="h-7 w-full text-xs" onClick={handleAddTags} disabled={!tagsInput.trim()}>
            Add to {selectedNodeIds.length}
          </Button>
        </InlinePanel>
      )}
      {openForm === 'color' && (
        <InlinePanel title="Set color" onCancel={() => setOpenForm(null)}>
          <div className="grid grid-cols-3 gap-1.5">
            {COLORS.map(c => (
              <button
                key={c.name}
                onClick={() => handleSetColor(c)}
                className={cn('h-8 rounded border-2 transition-transform hover:scale-110', c.bg, c.border)}
                title={c.name}
              />
            ))}
          </div>
          <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={() => handleSetColor(null)}>
            Clear color
          </Button>
        </InlinePanel>
      )}
      {openForm === 'layers' && (
        <InlinePanel title="Move to layer" onCancel={() => setOpenForm(null)}>
          <p className="text-muted-foreground text-[10px]">Replaces layer membership wholesale. "global" = visible on every layer.</p>
          <Input
            value={layersInput}
            onChange={e => setLayersInput(e.target.value)}
            placeholder="layer names (comma-separated)"
            onKeyDown={e => {
              if (e.key === 'Enter') handleSetLayers()
              if (e.key === 'Escape') setOpenForm(null)
            }}
            className="h-7 text-xs"
            autoFocus
          />
          {(activeLayer || knownLayers.length > 0) && (
            <div className="flex flex-wrap gap-1">
              {activeLayer && (
                <button
                  type="button"
                  onClick={() => handleSetLayers([activeLayer])}
                  className="rounded border border-emerald-400 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-900 hover:bg-emerald-100"
                >
                  → active: {activeLayer}
                </button>
              )}
              {knownLayers
                .filter(l => l !== activeLayer)
                .map(l => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => handleSetLayers([l])}
                    className="rounded border border-stone-200 px-2 py-0.5 text-[10px] text-stone-700 hover:bg-stone-50"
                  >
                    → {l}
                  </button>
                ))}
              <button
                type="button"
                onClick={() => handleSetLayers([])}
                className="rounded border border-dashed border-stone-300 px-2 py-0.5 text-[10px] text-stone-500 hover:bg-stone-50"
              >
                → global ([])
              </button>
            </div>
          )}
          <Button size="sm" className="h-7 w-full text-xs" onClick={() => handleSetLayers()}>
            Apply to {selectedNodeIds.length}
          </Button>
        </InlinePanel>
      )}
      {openForm === 'sort' && (
        <InlinePanel title="Arrange" onCancel={() => setOpenForm(null)}>
          <div className="grid grid-cols-2 gap-1">
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => handleSort('TB')}>
              <ArrowDownUp className="mr-1 h-3 w-3" /> Top→Bottom
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => handleSort('LR')}>
              <ArrowLeftRight className="mr-1 h-3 w-3" /> Left→Right
            </Button>
          </div>
          {selectedNodeIds.length >= 2 && (
            <>
              <div className="text-muted-foreground mt-1 text-[10px] font-semibold tracking-wide uppercase">
                Align {selectedNodeIds.length}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <AlignButton
                  icon={<AlignHorizontalJustifyCenter className="h-3 w-3" />}
                  label="H-line"
                  onClick={() => handleAlign('horizontal-line')}
                />
                <AlignButton
                  icon={<AlignVerticalJustifyCenter className="h-3 w-3" />}
                  label="V-line"
                  onClick={() => handleAlign('vertical-line')}
                />
                <AlignButton icon={<Grid3x3 className="h-3 w-3" />} label="Grid" onClick={() => handleAlign('grid')} />
                <AlignButton icon={<StretchHorizontal className="h-3 w-3" />} label="Dist H" onClick={() => handleAlign('distribute-h')} />
                <AlignButton icon={<StretchVertical className="h-3 w-3" />} label="Dist V" onClick={() => handleAlign('distribute-v')} />
              </div>
            </>
          )}
        </InlinePanel>
      )}

      {/* Selected node list */}
      <div className="border-b border-stone-100">
        {selectedNodes.map(n => {
          const data = n.data as any
          const type = (data.type as string) || 'USER'
          return (
            <InspectorRow key={n.id} onClick={() => focusNode(n.id, n.position, (data.scale as number) || 1)}>
              <span
                className={cn(
                  'rounded px-1 py-0.5 text-[9px] font-medium',
                  type === 'ASSISTANT' && 'bg-gray-900 text-gray-100',
                  type === 'TEXT' && 'bg-amber-100 text-amber-700',
                  (type === 'ZONE' || type === 'DRAWING') && 'bg-slate-100 text-slate-600',
                  type !== 'ASSISTANT' && type !== 'TEXT' && type !== 'ZONE' && type !== 'DRAWING' && 'bg-blue-100 text-blue-700'
                )}
              >
                {type === 'ASSISTANT' ? 'AI' : type === 'TEXT' ? 'TX' : type === 'ZONE' ? 'ZN' : type === 'DRAWING' ? 'DR' : 'YOU'}
              </span>
              <span className="flex-1 truncate text-gray-700">
                {getDisplayText((data.label as string | null) || null, (data.content as string) || '')}
              </span>
            </InspectorRow>
          )
        })}
      </div>

      {/* Sliders — wider column means useful precision */}
      <div className="space-y-3 px-3 py-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1 text-[10px] font-semibold tracking-wide uppercase">
              <Scaling className="h-3 w-3" /> Scale
            </span>
            <span className="text-xs font-semibold text-gray-700 tabular-nums">{Math.round(scaleValue * 100)}%</span>
          </div>
          <Slider
            min={0}
            max={1}
            step={SCALE_SLIDER_STEP}
            value={[scaleToSlider(scaleValue)]}
            onValueChange={handleScaleChange}
            onValueCommit={handleScaleCommit}
            onPointerDown={handleScaleStart}
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1 text-[10px] font-semibold tracking-wide uppercase">
              <Shrink className="h-3 w-3" /> Spacing
            </span>
            <span className="text-xs font-semibold text-gray-700 tabular-nums">{Math.round(compactValue * 100)}%</span>
          </div>
          <Slider
            min={0}
            max={1}
            step={0.001}
            value={[spacingToSlider(compactValue)]}
            onValueChange={handleCompactChange}
            onPointerDown={handleCompactStart}
            onPointerUp={handleCompactEnd}
          />
        </div>
      </div>

      {/* Delete with two-step confirm. First click arms; second click commits.
          The button visibly mutates so the second click is unambiguous. */}
      <div className="border-t border-stone-200">
        <button
          type="button"
          onClick={handleDeleteSelected}
          className={cn(
            'flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors',
            confirmDelete ? 'bg-red-600 text-white hover:bg-red-700' : 'text-red-600 hover:bg-red-50'
          )}
        >
          <Trash2 className="h-3 w-3" />
          {confirmDelete
            ? `Click again to delete ${selectedNodes.length}`
            : `Delete ${selectedNodes.length} node${selectedNodes.length !== 1 ? 's' : ''}`}
        </button>
      </div>
    </InspectorColumn>
  )
}

function SubBlock({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="p-1.5">
      <div className="mb-1 flex items-center gap-1 px-1 text-[10px] font-semibold tracking-wide text-gray-500 uppercase">
        {icon}
        <span className="flex-1">{title}</span>
        {count > 0 && <span className="rounded bg-white px-1 py-0.5 text-[9px] text-stone-500 tabular-nums">{count}</span>}
      </div>
      <div className="max-h-[180px] overflow-y-auto pr-0.5">{children}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground px-2 py-1 text-[10px] italic">{children}</div>
}

function BulkButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-col items-center justify-center gap-0.5 border-r border-b border-stone-200 bg-white px-2 py-2 text-[10px] font-medium text-gray-700 transition-colors',
        'hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white',
        active && 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300 ring-inset hover:bg-emerald-50'
      )}
    >
      <span className={cn(active && 'text-emerald-600')}>{icon}</span>
      {label}
    </button>
  )
}

function InlinePanel({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  return (
    <div className="space-y-2 border-b border-stone-200 bg-emerald-50/40 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-wider text-emerald-700 uppercase">{title}</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-0.5 text-stone-400 hover:bg-white hover:text-stone-700"
          aria-label="Cancel"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {children}
    </div>
  )
}

function AlignButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={onClick}>
      <span className="mr-1 inline-flex">{icon}</span>
      {label}
    </Button>
  )
}
