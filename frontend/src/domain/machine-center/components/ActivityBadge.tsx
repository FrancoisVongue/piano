'use client'

import { Loader2, Bell, XCircle, Activity, CheckCircle2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MachineActivity, MachineActivityGroup } from '../services'
import { ActivityView } from '../types'

// Activity has its own visual language, deliberately disjoint from the
// container status dots (which own green = running / sky = frozen / gray).
// Every kind gets BOTH a distinct icon and a distinct tone — no two look alike:
//   attention → Bell    + amber   (someone/something wants you)
//   failed    → XCircle + red     (last command exited non-zero)
//   running   → Loader2 + neutral (spinner — motion, never green/sky)
//   signal    → Activity + neutral (free-form progress label)
//   done      → CheckCircle2 + muted (finished / exit 0)
const KIND_ICON: Record<ActivityView.Kind, LucideIcon | null> = {
  attention: Bell,
  failed: XCircle,
  running: Loader2,
  signal: Activity,
  done: CheckCircle2,
  idle: null,
}

const pillTone: Record<ActivityView.Kind, string> = {
  attention: 'bg-amber-500/15 text-amber-600',
  failed: 'bg-red-500/15 text-red-600',
  running: 'text-muted-foreground',
  signal: 'bg-muted text-muted-foreground',
  done: 'text-muted-foreground/70',
  idle: '',
}

function KindIcon({ kind, className }: { kind: ActivityView.Kind; className?: string }) {
  const Icon = KIND_ICON[kind]
  if (!Icon) return null
  return <Icon className={cn(kind === 'running' && 'animate-spin', className)} />
}

function Pill({ activity }: { activity: MachineActivity }) {
  const d = ActivityView.classify(activity)
  if (d.kind === 'idle') return null
  return (
    <span title={d.title} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium max-w-[12rem] truncate', pillTone[d.kind])}>
      <KindIcon kind={d.kind} className="h-3 w-3 shrink-0" />
      {d.label && <span className="truncate">{d.label}</span>}
    </span>
  )
}

// Compact per-pane indicator (used in terminal pane chrome). Calm (idle/done)
// renders nothing so quiet panes stay quiet.
export function ActivityDot({ activity, className }: { activity?: MachineActivity; className?: string }) {
  if (!activity) return null
  const d = ActivityView.classify(activity)
  if (d.kind === 'idle' || d.kind === 'done' || d.kind === 'signal') return null
  if (d.kind === 'running')
    return (
      <span title={d.title} className={cn('inline-flex', className)}>
        <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
      </span>
    )
  return (
    <span
      title={d.title}
      className={cn('inline-block h-2 w-2 rounded-full', d.kind === 'attention' ? 'bg-amber-500' : 'bg-red-500', className)}
    />
  )
}

const bannerTone: Record<ActivityView.Kind, string> = {
  attention: 'text-amber-600',
  failed: 'text-red-600',
  running: 'text-stone-500',
  signal: 'text-stone-600',
  done: 'text-stone-500',
  idle: 'text-stone-500',
}

// Prominent, centered activity for a card body (MachineNode) — sits where the
// terminal text is rather than crammed into a header. Calm (idle/done) renders
// nothing so the output preview stays visible underneath.
export function ActivityBanner({
  activity,
  group,
}: {
  activity?: MachineActivity
  group?: MachineActivityGroup
}) {
  const summary = ActivityView.summaryOf(group, activity)
  if (!summary) return null
  const d = ActivityView.classify(summary)
  // Only true idle is hidden — explicit `piano done` (kind 'done') is a
  // deliberate completion notice and must show.
  if (d.kind === 'idle') return null

  return (
    <div className="flex max-w-[90%] flex-col items-center gap-1.5 rounded-md bg-[#e8ecea]/85 px-3 py-2 text-center shadow-sm backdrop-blur-[1px]">
      <KindIcon kind={d.kind} className={cn('h-5 w-5', bannerTone[d.kind])} />
      <span className={cn('font-mono text-[11px] leading-snug break-words line-clamp-3', bannerTone[d.kind])}>
        {d.label || d.kind}
      </span>
      {group && group.total > 1 && (
        <span className="font-mono text-[10px] text-stone-500">
          {group.total} terminals
          {group.attention > 0 ? ` · ⚠${group.attention}` : ''}
          {group.failed > 0 ? ` · ✕${group.failed}` : ''}
          {group.running > 0 ? ` · ●${group.running}` : ''}
        </span>
      )}
    </div>
  )
}

// Container-level badge: the loudest terminal as a pill + a count chip when the
// container holds more than one terminal (tooltip breaks it down per terminal).
// `group` is the daemon rollup; `activity` is the single-machine fallback.
// Renders nothing when frozen or calm.
export function ActivityBadge({
  activity,
  group,
  frozen,
}: {
  activity?: MachineActivity
  group?: MachineActivityGroup
  frozen?: boolean
}) {
  if (frozen) return null
  const summary = ActivityView.summaryOf(group, activity)
  if (!summary || ActivityView.classify(summary).kind === 'idle') return null

  const multi = group && group.total > 1
  if (!multi) return <Pill activity={summary} />

  const g = group!
  const tooltip = g.terminals.map(t => `${t.machineId.slice(0, 8)} · ${ActivityView.describe(t.activity)}`).join('\n')
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      <Pill activity={summary} />
      <span title={tooltip} className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground tabular-nums cursor-default">
        <span>{g.total} term</span>
        {g.attention > 0 && <span className="text-amber-600">⚠{g.attention}</span>}
        {g.failed > 0 && <span className="text-red-600">✕{g.failed}</span>}
        {g.running > 0 && <span>●{g.running}</span>}
      </span>
    </span>
  )
}
