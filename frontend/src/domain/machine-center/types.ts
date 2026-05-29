import type { MachineActivity, MachineActivityGroup, MachineMetrics } from './services'

// UI view-model for machine activity. Pure: maps the raw daemon signal into a
// display descriptor so every surface (Mission Control row, canvas MachineNode
// header, per-pane chrome) paints it the same way.
//
// The "loudness" ordering here MIRRORS the daemon's RollupActivity severity
// (daemon/activity.go). If you add a kind, update both sides.
export namespace ActivityView {
  // The `piano notify` convention: it emits signal === ATTENTION. This is the
  // one frontend anchor of a contract shared three ways — daemon mirrors it as
  // ActivitySignalAttention (activity.go) and piano.sh emits the literal
  // string. Change one, change all three.
  // Known piano signal labels (the contract with piano.sh): `notify` emits
  // ATTENTION, `done` emits DONE; anything else is a free-form progress label.
  export const ATTENTION = 'attention'
  export const DONE = 'done'

  export type Kind = 'attention' | 'failed' | 'running' | 'signal' | 'done' | 'idle'

  export type Descriptor = {
    kind: Kind
    label: string // short text for a pill
    title: string // tooltip / a11y
  }

  // Classify a single terminal's activity into one display kind. Each kind gets
  // its own icon + tone downstream — no two kinds should look alike.
  export const classify = (a: MachineActivity): Descriptor => {
    if (a.signal === ATTENTION)
      return { kind: 'attention', label: a.message || 'needs attention', title: a.message || 'needs attention' }
    if (a.phase === 'running')
      return { kind: 'running', label: 'running', title: 'a command is running' }
    if (a.signal === DONE)
      return { kind: 'done', label: a.message || 'done', title: a.message || 'done' }
    if (a.signal)
      return { kind: 'signal', label: a.message ? `${a.signal}: ${a.message}` : a.signal, title: a.message || a.signal }
    // A non-zero exit is a (sticky) failure worth surfacing. A clean exit 0 is
    // just "succeeded and now at rest" — that's calm/idle, not something to
    // plaster on every machine after every command. Explicit `piano done` is
    // the way to deliberately mark completion (handled above).
    if (a.lastExitCode !== undefined && a.lastExitCode !== 0)
      return { kind: 'failed', label: `exit ${a.lastExitCode}`, title: 'last command failed' }
    return { kind: 'idle', label: '', title: 'idle' }
  }

  // Short human string for a per-terminal tooltip line.
  export const describe = (a: MachineActivity): string => {
    const d = classify(a)
    return d.kind === 'idle' ? 'idle' : d.label
  }

  // The activity a container row should show: the rollup summary (loudest of
  // the container's terminals) if present, else the machine's own activity.
  export const summaryOf = (
    group: MachineActivityGroup | undefined,
    own: MachineActivity | undefined,
  ): MachineActivity | undefined => group?.summary ?? own

  // Find one terminal's activity inside a container rollup, by machine id.
  // Used by per-pane chrome: a window's primary machine carries the breakdown
  // of every pane (primary + shared), so a pane reads its own line from there.
  export const terminalIn = (
    group: MachineActivityGroup | undefined,
    machineId: string,
  ): MachineActivity | undefined => group?.terminals.find(t => t.machineId === machineId)?.activity

  // Convenience: scan a metrics record for the container rollup + own activity.
  export const fromMetrics = (metrics: MachineMetrics | null | undefined) => ({
    own: metrics?.activity,
    group: metrics?.activityGroup,
  })
}
