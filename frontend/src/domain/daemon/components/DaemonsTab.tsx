'use client'

import { useEffect, useState } from 'react'
import { Daemon } from '@piano/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Info, Plus, Trash2, Server, Pencil, Check, X, Copy, Pause, Play, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { useDaemons } from '../hooks/useDaemons'
import { API_CONFIG } from '@/config'

// User-facing surface for managing paired daemons:
//   1. Show the list (status pill + last-seen + rename/delete + pause/rotate).
//   2. The "Add daemon" flow — name input → backend mints a code → render
//      the CLI command the user pastes on their machine.
type PairingPanel =
  | { kind: 'pair-code'; pairing: Daemon.PairingCodeModel }
  | { kind: 'rotated'; daemonId: string; daemonName: string; token: string }

export function DaemonsTab() {
  const {
    daemons, isLoading,
    createPairingCode, cancelPairingCode, isCreatingCode,
    rename, remove, isRemoving,
    rotateToken, setPaused,
  } = useDaemons({ pollingMs: 10_000 })
  const [panel, setPanel] = useState<PairingPanel | null>(null)
  const [newDaemonName, setNewDaemonName] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Daemons</h2>
        <p className="text-muted-foreground">
          Each daemon is a piano-daemon process running on one of your machines. Pair as many as
          you want — desktop, laptop, server. Machines you create from the canvas live on the daemon
          you pick at create time.
        </p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Daemons connect outbound — no port forwarding, no public IP needed. The pairing code is
          one-time and expires in 10 minutes. The bearer token shown to your daemon is stored only
          on that machine; if it leaks, delete the daemon here and pair again.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Add daemon</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="Name (e.g. Home desktop)"
              value={newDaemonName}
              onChange={(e) => { setNewDaemonName(e.target.value); setError(null) }}
              disabled={isCreatingCode}
            />
            <Button
              onClick={async () => {
                setError(null)
                try {
                  const code = await createPairingCode(newDaemonName.trim())
                  setPanel({ kind: 'pair-code', pairing: code })
                  setNewDaemonName('')
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Failed to create code')
                }
              }}
              disabled={isCreatingCode || !newDaemonName.trim()}
            >
              <Plus className="mr-2 h-4 w-4" />
              {isCreatingCode ? '…' : 'Generate code'}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          {panel && (
            <PairingInstructions
              panel={panel}
              onClose={() => {
                if (panel.kind === 'pair-code') {
                  // Best-effort cancel — code expires anyway, but cleaning up
                  // immediately keeps the DB tidy and frees the daemon name.
                  cancelPairingCode(panel.pairing.code).catch(() => undefined)
                }
                setPanel(null)
              }}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your daemons</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : daemons.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No daemons paired yet. Generate a code above to add your first one.
            </p>
          ) : (
            daemons.map(d => (
              <DaemonRow
                key={d.id}
                daemon={d}
                onRename={(name) => rename({ daemonId: d.id, name })}
                onDelete={() => remove(d.id)}
                onTogglePause={() => setPaused({ daemonId: d.id, paused: !d.isPaused })}
                onRotateToken={async () => {
                  if (!confirm(`Rotate token for "${d.name}"? The current daemon process will be disconnected — you'll need to paste the new pairing command on its host to bring it back online.`)) return
                  try {
                    const result = await rotateToken(d.id)
                    setPanel({ kind: 'rotated', daemonId: result.daemonId, daemonName: result.name, token: result.token })
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Rotate failed')
                  }
                }}
                isRemoving={isRemoving}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function DaemonRow({
  daemon,
  onRename,
  onDelete,
  onTogglePause,
  onRotateToken,
  isRemoving,
}: {
  daemon: Daemon.Model
  onRename: (name: string) => Promise<unknown>
  onDelete: () => Promise<unknown>
  onTogglePause: () => Promise<unknown>
  onRotateToken: () => Promise<unknown>
  isRemoving: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(daemon.name)

  const lastSeen = daemon.lastSeenAt ? new Date(daemon.lastSeenAt).toLocaleString() : 'never'
  const isOnline = daemon.status === 'online'
  // IDE tunnel label — backend allocates the port at pair time, so when sshPort
  // is set we know "Open in IDE" works for any machine on this daemon.
  const tunnelLabel = daemon.sshPort ? `IDE port: ${daemon.sshPort}` : null
  const subtitle = daemon.isPaused
    ? 'Paused — not dispatching new work'
    : isOnline
      ? 'Connected now'
      : `Last seen: ${lastSeen}`

  return (
    <div className="flex items-center justify-between p-3 rounded-md bg-muted/50">
      <div className="flex items-center gap-3 min-w-0">
        <Server className="h-4 w-4 text-muted-foreground shrink-0" />
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${
            daemon.isPaused ? 'bg-amber-500' : isOnline ? 'bg-green-500' : 'bg-muted-foreground/50'
          }`}
          title={daemon.isPaused ? 'Paused' : isOnline ? 'Online' : 'Offline'}
        />
        {editing ? (
          <div className="flex gap-1 flex-1">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className="h-8"
            />
            <Button size="sm" variant="ghost" onClick={async () => {
              if (!draft.trim() || draft === daemon.name) { setEditing(false); return }
              try { await onRename(draft.trim()); setEditing(false) }
              catch (err) { toast.error(err instanceof Error ? err.message : 'Rename failed') }
            }}><Check className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={() => { setDraft(daemon.name); setEditing(false) }}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="font-medium truncate">{daemon.name}</div>
            <div className="text-xs text-muted-foreground">
              {subtitle}{tunnelLabel ? ` · ${tunnelLabel}` : ''}
            </div>
          </div>
        )}
      </div>
      {!editing && (
        <div className="flex gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try { await onTogglePause() }
              catch (err) { toast.error(err instanceof Error ? err.message : 'Failed') }
            }}
            title={daemon.isPaused ? 'Resume — start dispatching work again' : 'Pause — stop dispatching new work'}
          >
            {daemon.isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRotateToken} title="Rotate token">
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title="Rename">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isRemoving}
            onClick={async () => {
              if (!confirm(`Delete daemon "${daemon.name}"? Machines on this daemon will become unreachable until you pair another one and reassign them.`)) return
              try { await onDelete() }
              catch (err) { toast.error(err instanceof Error ? err.message : 'Delete failed') }
            }}
            className="text-muted-foreground hover:text-destructive"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

function PairingInstructions({
  panel,
  onClose,
}: {
  panel: PairingPanel
  onClose: () => void
}) {
  const backendBase = API_CONFIG.API_URL.replace(/\/api\/?$/, '')

  if (panel.kind === 'pair-code') {
    return <PairCodePanel pairing={panel.pairing} backendBase={backendBase} onClose={onClose} />
  }
  return (
    <RotatedTokenPanel
      daemonId={panel.daemonId}
      daemonName={panel.daemonName}
      token={panel.token}
      backendBase={backendBase}
      onClose={onClose}
    />
  )
}

function CopyButton({ value }: { value: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        toast.success('Copied')
      }}
    >
      <Copy className="h-4 w-4" />
    </Button>
  )
}

function PairCodePanel({
  pairing,
  backendBase,
  onClose,
}: {
  pairing: Daemon.PairingCodeModel
  backendBase: string
  onClose: () => void
}) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000))
  )
  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)))
    }, 1000)
    return () => clearInterval(interval)
  }, [pairing.expiresAt])

  const command = `sudo piano-daemon pair ${pairing.code} --backend ${backendBase}`
  const expired = secondsLeft <= 0
  const mm = Math.floor(secondsLeft / 60)
  const ss = secondsLeft % 60

  return (
    <div className="mt-4 rounded-md border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Pair daemon "{pairing.name}"</div>
          <div className="text-xs text-muted-foreground">
            {expired
              ? <span className="text-destructive">Code expired — generate a new one.</span>
              : <>Expires in {mm}:{String(ss).padStart(2, '0')}</>}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Code</Label>
        <div className="flex gap-1 mt-1">
          <code className="flex-1 px-3 py-2 rounded-md bg-muted font-mono text-sm">{pairing.code}</code>
          <CopyButton value={pairing.code} />
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Run on the daemon machine</Label>
        <div className="flex gap-1 mt-1">
          <code className="flex-1 px-3 py-2 rounded-md bg-muted font-mono text-xs break-all">{command}</code>
          <CopyButton value={command} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          The daemon will connect within seconds. This panel will close once it shows up below.
        </p>
      </div>
    </div>
  )
}

function RotatedTokenPanel({
  daemonId,
  daemonName,
  token,
  backendBase,
  onClose,
}: {
  daemonId: string
  daemonName: string
  token: string
  backendBase: string
  onClose: () => void
}) {
  // `.` separator (was `:`): tokens are hex so `.` never collides; if we
  // later switch to a token format that may contain `:` (e.g. JWT), the
  // CLI's SplitN keeps working unchanged.
  const encoded = `piano-token.${daemonId}.${token}`
  const command = `sudo piano-daemon set-token ${encoded} --backend ${backendBase}`
  return (
    <div className="mt-4 rounded-md border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">New token for "{daemonName}"</div>
          <div className="text-xs text-muted-foreground">
            Shown once. Close this and you'll have to rotate again.
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Run on the daemon machine, then restart the daemon</Label>
        <div className="flex gap-1 mt-1">
          <code className="flex-1 px-3 py-2 rounded-md bg-muted font-mono text-xs break-all">{command}</code>
          <CopyButton value={command} />
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          The running daemon keeps the old token in memory until the process restarts.
          Kill and restart the process by hand, or use systemctl if you've set up a unit.
        </p>
      </div>
    </div>
  )
}
