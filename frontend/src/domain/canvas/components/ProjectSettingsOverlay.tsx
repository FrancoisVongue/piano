'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { X, Settings, Brain, Zap, ScrollText, RotateCcw, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Arrangement, LLM } from '@piano/shared'
import { useActiveModels } from '@/domain/settings/hooks/useSettings'
import { useUserProfile } from '@/domain/settings/hooks/useSettings'
import { useActionsContext } from '@/domain/action/ActionsContext'
import { ReorderableHotkeyList } from '@/lib/ReorderableHotkeyList'
import { partitionByVisibility } from '@/lib/visibilityOrder'

type ModelsConfig = NonNullable<Arrangement.Config['models']>

const MODEL_HOTKEYS = ['q', 'w', 'e', 'r'] as const
const ACTION_HOTKEYS = ['a', 's', 'd', 'f'] as const

type Section = 'models' | 'actions' | 'system'

interface ProjectSettingsOverlayProps {
  open: boolean
  onClose: () => void
  arrangement: Arrangement.Model | null
  modelsConfig: ModelsConfig | null
  onModelsConfigChange: (next: ModelsConfig | null) => void
  onSystemPromptSave: (systemPrompt: string | null) => Promise<void> | void
}

/**
 * Inline overlay (NOT a modal portal). Renders inside the canvas region
 * via absolute positioning, so the surrounding chrome (sidebar, project
 * tabs) stays visible and the user keeps their orientation. Esc / X
 * dismisses; nothing about the route changes.
 *
 * Sections:
 *   - Models    → which AI models are visible + ordered (hotkeys q/w/e/r)
 *   - Actions   → which actions are visible + ordered (hotkeys a/s/d/f)
 *   - System    → per-project system prompt (with global default preview)
 */
export function ProjectSettingsOverlay({
  open,
  onClose,
  arrangement,
  modelsConfig,
  onModelsConfigChange,
  onSystemPromptSave,
}: ProjectSettingsOverlayProps) {
  const { models: allModels } = useActiveModels()
  const { profile } = useUserProfile()
  const { allActions, actionsConfig, updateActionsConfig } = useActionsContext()

  const [systemPromptDraft, setSystemPromptDraft] = useState('')
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [section, setSection] = useState<Section>('models')

  useEffect(() => {
    setSystemPromptDraft(arrangement?.systemPrompt ?? '')
  }, [arrangement?.systemPrompt, arrangement?.id])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const { visible: visibleModels, hidden: hiddenModels } = partitionByVisibility(
    allModels,
    modelsConfig?.visibleIds,
  )
  const { visible: visibleActions, hidden: hiddenActions } = partitionByVisibility(
    allActions,
    actionsConfig?.visibleIds,
  )

  const onModelReorder = useCallback((ids: string[]) => {
    onModelsConfigChange({ visibleIds: ids })
  }, [onModelsConfigChange])

  const onModelToggle = useCallback((id: string) => {
    const cur = modelsConfig?.visibleIds ?? allModels.map(m => m.id)
    const next = cur.includes(id) ? cur.filter(v => v !== id) : [...cur, id]
    onModelsConfigChange(next.length === 0 ? null : { visibleIds: next })
  }, [modelsConfig, allModels, onModelsConfigChange])

  const onActionReorder = useCallback((ids: string[]) => {
    updateActionsConfig({ visibleIds: ids })
  }, [updateActionsConfig])

  const onActionToggle = useCallback((id: string) => {
    const cur = actionsConfig?.visibleIds ?? allActions.map(a => a.id)
    const next = cur.includes(id) ? cur.filter(v => v !== id) : [...cur, id]
    updateActionsConfig(next.length === 0 ? null : { visibleIds: next })
  }, [actionsConfig, allActions, updateActionsConfig])

  const handleSavePrompt = async () => {
    setSavingPrompt(true)
    try {
      const trimmed = systemPromptDraft.trim()
      await onSystemPromptSave(trimmed === '' ? null : systemPromptDraft)
    } finally {
      setSavingPrompt(false)
    }
  }

  if (!open) return null

  const hasUserDefault = !!profile?.defaultSystemPrompt?.trim()
  const hasArrangementPrompt = !!arrangement?.systemPrompt?.trim()
  const hasModelOverrides = modelsConfig !== null
  const hasActionOverrides = actionsConfig !== null
  const promptDirty = systemPromptDraft !== (arrangement?.systemPrompt ?? '')

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white animate-in fade-in duration-150">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-stone-200 bg-white/95 px-6 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-stone-100 p-1.5">
            <Settings className="h-4 w-4 text-stone-700" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">Project settings</h2>
              {arrangement?.title && (
                <span className="rounded bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
                  {arrangement.title}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Configure visible models, actions, and a per-project system prompt.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5">
          <X className="h-4 w-4" /> Close
          <kbd className="ml-1 rounded border border-stone-300 bg-stone-50 px-1 text-[10px] font-normal">Esc</kbd>
        </Button>
      </div>

      {/* Body — left nav + main pane */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav className="flex w-52 flex-shrink-0 flex-col gap-0.5 border-r border-stone-200 bg-stone-50/50 p-2">
          <SectionTab
            icon={<Brain className="h-4 w-4" />}
            label="Models"
            kbd="q w e r"
            active={section === 'models'}
            overridden={hasModelOverrides}
            badge={hasModelOverrides ? `${visibleModels.length}/${allModels.length}` : null}
            onClick={() => setSection('models')}
          />
          <SectionTab
            icon={<Zap className="h-4 w-4" />}
            label="Actions"
            kbd="a s d f"
            active={section === 'actions'}
            overridden={hasActionOverrides}
            badge={hasActionOverrides ? `${visibleActions.length}/${allActions.length}` : null}
            onClick={() => setSection('actions')}
          />
          <SectionTab
            icon={<ScrollText className="h-4 w-4" />}
            label="System prompt"
            kbd=""
            active={section === 'system'}
            overridden={hasArrangementPrompt}
            badge={hasArrangementPrompt ? 'set' : null}
            onClick={() => setSection('system')}
          />
        </nav>

        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-8">
            {section === 'models' && (
              <Section
                title="Models"
                description="Pick which AI models show up in the toolbar selector. Drag rows to reorder — the top four bind to Alt + q / w / e / r. Hidden models still exist globally; this only controls what's visible in this project."
                onReset={hasModelOverrides ? () => onModelsConfigChange(null) : undefined}
              >
                {allModels.length === 0 ? (
                  <EmptyHint>
                    Add a provider API key to unlock models.{' '}
                    <Link href="/settings" className="font-medium text-amber-600 hover:underline">
                      Open Settings <ExternalLink className="ml-0.5 inline h-3 w-3" />
                    </Link>
                  </EmptyHint>
                ) : (
                  <ReorderableHotkeyList
                    visibleItems={visibleModels}
                    hiddenItems={hiddenModels}
                    hotkeyLabels={MODEL_HOTKEYS}
                    onReorder={onModelReorder}
                    onToggleVisibility={onModelToggle}
                    renderItemBody={renderModelBody}
                    renderHiddenItemBody={renderHiddenModelBody}
                    hideTooltip="Hide model"
                  />
                )}
              </Section>
            )}

            {section === 'actions' && (
              <Section
                title="Actions"
                description="Which actions show up when you have a node selected. Top four bind to Alt + a / s / d / f. Reorder by dragging; hide what you don't use in this project."
                onReset={hasActionOverrides ? () => updateActionsConfig(null) : undefined}
              >
                {allActions.length === 0 ? (
                  <EmptyHint>No actions are defined yet.</EmptyHint>
                ) : (
                  <ReorderableHotkeyList
                    visibleItems={visibleActions}
                    hiddenItems={hiddenActions}
                    hotkeyLabels={ACTION_HOTKEYS}
                    onReorder={onActionReorder}
                    onToggleVisibility={onActionToggle}
                    renderItemBody={(action) => (
                      <>
                        <Zap className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
                        <span className="flex-1 truncate">{action.name}</span>
                      </>
                    )}
                    renderHiddenItemBody={(action) => (
                      <>
                        <Zap className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
                        <span className="flex-1 truncate text-gray-400">{action.name}</span>
                      </>
                    )}
                    hideTooltip="Hide action"
                  />
                )}
              </Section>
            )}

            {section === 'system' && (
              <Section
                title="System prompt"
                description="Prepended to every AI run inside this project, after your global default. Both layers reach the model."
              >
                <div className="space-y-5 p-5">
                  <div className="rounded-md border border-stone-200 bg-stone-50/60 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Global default
                      </span>
                      <Link
                        href="/settings"
                        className="inline-flex items-center gap-1 text-[11px] text-amber-600 hover:underline"
                      >
                        Edit in Settings <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                    <p className={cn(
                      'text-xs whitespace-pre-wrap',
                      hasUserDefault ? 'text-foreground' : 'italic text-muted-foreground',
                    )}>
                      {hasUserDefault ? profile!.defaultSystemPrompt : 'Not set — configure one in Settings → Profile.'}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Project override
                      </span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {systemPromptDraft.length} / 10000
                      </span>
                    </div>
                    <Textarea
                      value={systemPromptDraft}
                      onChange={e => setSystemPromptDraft(e.target.value)}
                      placeholder="You are a senior code reviewer. Focus on correctness, avoid nits…"
                      className="min-h-[220px] font-mono text-sm"
                      disabled={!arrangement}
                    />
                    <div className="flex items-center justify-end gap-2 pt-1">
                      {hasArrangementPrompt && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            setSystemPromptDraft('')
                            await onSystemPromptSave(null)
                          }}
                          disabled={savingPrompt || !arrangement}
                        >
                          Clear
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={handleSavePrompt}
                        disabled={savingPrompt || !arrangement || !promptDirty}
                      >
                        {savingPrompt ? 'Saving…' : promptDirty ? 'Save' : 'Saved'}
                      </Button>
                    </div>
                  </div>
                </div>
              </Section>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function SectionTab({
  icon,
  label,
  kbd,
  active,
  overridden,
  badge,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  kbd: string
  active: boolean
  overridden: boolean
  badge: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
        active
          ? 'bg-white shadow-sm font-medium text-foreground ring-1 ring-stone-200'
          : 'text-muted-foreground hover:bg-white/60 hover:text-foreground',
      )}
    >
      <span className={cn('flex-shrink-0', active ? 'text-stone-900' : 'text-stone-500')}>
        {icon}
      </span>
      <span className="flex-1 truncate">
        <span className="block leading-tight">{label}</span>
        {kbd && (
          <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {kbd}
          </span>
        )}
      </span>
      {badge && (
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
            overridden ? 'bg-amber-100 text-amber-700' : 'bg-stone-200 text-stone-600',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

function Section({
  title,
  description,
  children,
  onReset,
}: {
  title: string
  description: string
  children: React.ReactNode
  onReset?: () => void
}) {
  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {onReset && (
          <Button variant="ghost" size="sm" onClick={onReset} className="flex-shrink-0 gap-1 text-xs">
            <RotateCcw className="h-3 w-3" /> Reset
          </Button>
        )}
      </div>
      <div className="rounded-md border border-stone-200 bg-white overflow-hidden">{children}</div>
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>
}

const renderModelBody = (model: LLM.Model) => {
  const viaRouter = model.provider === 'OPENROUTER'
  return (
    <>
      <Brain className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{model.name}</span>
          {viaRouter && (
            <span
              title="Routed through OpenRouter"
              className="rounded bg-violet-100 px-1 py-px text-[9px] font-bold tracking-wider text-violet-700"
            >
              OR
            </span>
          )}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {viaRouter ? 'via OpenRouter' : model.provider}
        </div>
      </div>
    </>
  )
}

const renderHiddenModelBody = (model: LLM.Model) => (
  <>
    <Brain className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
    <span className="flex-1 truncate text-gray-400">{model.name}</span>
  </>
)
