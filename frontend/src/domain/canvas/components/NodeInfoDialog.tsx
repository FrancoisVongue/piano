'use client'

import React, { useEffect, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Union } from '@/lib/types'
import { LLM } from '@piano/shared'
import { NoteRunsService, NoteRun } from '../services/note-runs'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

// -----------------------------------------------------------------------------
// NodeInfoDialog — small modal opened from the 3-dot menu's "Info" item.
// Shows the latest run that produced the note: tokens (total/cached/output),
// cache-hit ratio, model, and an estimated cost (±10%, label says so).
//
// Loads lazily on open so we don't pay for the query if the user never clicks.
// -----------------------------------------------------------------------------

interface Props {
  noteId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}

type State =
  | { tag: 'loading' }
  | { tag: 'none' }
  | { tag: 'ok'; run: NoteRun }
  | { tag: 'err'; message: string }

const fmtNum = (n: number) => n.toLocaleString('en-US')
const fmtPct = (ratio: number) => `${Math.round(ratio * 100)}%`
const fmtCost = (usd: number) => {
  if (usd < 0.01) return `<$0.01`
  if (usd < 1)    return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
const fmtTime = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString()
}

export function NodeInfoDialog({ noteId, open, onOpenChange }: Props) {
  const [state, setState] = useState<State>({ tag: 'loading' })

  useEffect(() => {
    if (!open) return
    setState({ tag: 'loading' })
    let cancelled = false
    NoteRunsService.latest(noteId).then(result => {
      if (cancelled) return
      Union.match({
        success: (payload) => {
          if (!payload) return setState({ tag: 'none' })
          setState({ tag: 'ok', run: payload.run })
        },
        error: ({ message }) => setState({ tag: 'err', message }),
      }, result)
    })
    return () => { cancelled = true }
  }, [open, noteId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Run info</DialogTitle>
          <DialogDescription>
            Usage and estimated cost for the last AI run that wrote this note.
          </DialogDescription>
        </DialogHeader>

        {state.tag === 'loading' && (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        )}

        {state.tag === 'none' && (
          <p className="text-sm text-muted-foreground py-4">
            This note has no runs yet. Run an action on it (or a descendant)
            and come back.
          </p>
        )}

        {state.tag === 'err' && (
          <p className="text-sm text-red-600 py-4">Failed to load: {state.message}</p>
        )}

        {state.tag === 'ok' && <RunInfoBody run={state.run} />}
      </DialogContent>
    </Dialog>
  )
}

const RunInfoBody = ({ run }: { run: NoteRun }) => {
  const model = LLM.getModelById(run.model as LLM.ModelId)
  const usage: LLM.RunUsage = {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cachedTokens: run.cachedTokens,
    modelId: run.model as LLM.ModelId,
    provider: model?.provider ?? 'OPENAI',
  }
  const cost = LLM.costFor(usage)
  const hitRatio = LLM.cacheHitRatio(usage)

  return (
    <div className="flex flex-col gap-3 text-sm">
      <Row label="Model" value={model?.name ?? run.model} />
      <Row label="When" value={fmtTime(run.createdAt)} />

      <div className="h-px bg-gray-200 my-1" />

      <Row label="Input tokens"  value={fmtNum(run.inputTokens)} />
      <Row
        label="Cached"
        value={
          <span>
            {fmtNum(run.cachedTokens)}
            {run.inputTokens > 0 && (
              <span className={cn(
                'ml-1.5 text-xs',
                hitRatio >= 0.5 ? 'text-emerald-600' : 'text-gray-500',
              )}>
                ({fmtPct(hitRatio)} hit)
              </span>
            )}
          </span>
        }
      />
      <Row label="Output tokens" value={fmtNum(run.outputTokens)} />

      <div className="h-px bg-gray-200 my-1" />

      <Row
        label="Estimated cost"
        value={
          cost === undefined ? (
            <span className="text-gray-500">no rate</span>
          ) : (
            <span title="Excludes cache storage & tier surcharges; ±10% variance">
              ~{fmtCost(cost)}
            </span>
          )
        }
      />
    </div>
  )
}

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
)
