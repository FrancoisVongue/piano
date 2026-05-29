'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMachineCenterStore } from '../store'
import { useDaemonPicker } from '@/domain/daemon/components/DaemonSelect'
import TerminalPanel from '@/domain/terminal/components/TerminalPanel'
import { ArrowLeft, Save, Play } from 'lucide-react'

export function SandboxPanel() {
  const sandboxMachineId = useMachineCenterStore(s => s.sandboxMachineId)
  const sandboxTemplateId = useMachineCenterStore(s => s.sandboxTemplateId)
  const sandboxDraftTemplateId = useMachineCenterStore(s => s.sandboxDraftTemplateId)
  const templates = useMachineCenterStore(s => s.templates)
  const startSandbox = useMachineCenterStore(s => s.startSandbox)
  const saveSandboxAsTemplate = useMachineCenterStore(s => s.saveSandboxAsTemplate)
  const closeSandbox = useMachineCenterStore(s => s.closeSandbox)

  const [isStarting, setIsStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [showNameInput, setShowNameInput] = useState(false)
  const [draftName, setDraftName] = useState('')

  // If the user forked from a template pinned to a specific daemon, lock the
  // picker to that host — templates' overlay files only exist on the daemon
  // they were saved on. Legacy templates (daemonId=null) and "blank machine"
  // leave the choice free.
  const activeTemplateId = sandboxMachineId ? sandboxTemplateId : sandboxDraftTemplateId
  const parentTemplate = templates.find(t => t.id === activeTemplateId)
  const {
    selectedDaemonId,
    setSelectedDaemonId,
    availableDaemons,
    isLoading: isLoadingDaemons,
    isPinned,
  } = useDaemonPicker({ pinnedDaemonId: parentTemplate?.daemonId ?? null })

  const canStart = useMemo(() => !!selectedDaemonId && !isStarting, [selectedDaemonId, isStarting])

  // Warn user before closing/refreshing the browser tab while a sandbox is active.
  useEffect(() => {
    if (!sandboxMachineId) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = 'You have an unsaved sandbox. Closing will discard your changes.'
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [sandboxMachineId])

  const handleStart = async () => {
    if (!selectedDaemonId) {
      setStartError('Pick a daemon to host the sandbox.')
      return
    }
    setIsStarting(true)
    setStartError(null)
    const machineId = await startSandbox(activeTemplateId || undefined, selectedDaemonId, draftName.trim() || undefined)
    setIsStarting(false)
    if (!machineId) {
      setStartError('Could not start sandbox. Check that the daemon is reachable.')
    }
  }

  const handleSave = async () => {
    if (!templateName.trim()) return
    setIsSaving(true)
    setSaveError(null)
    const result = await saveSandboxAsTemplate(templateName.trim())
    setIsSaving(false)
    if (!result) {
      setSaveError('Could not save template. Try again.')
      return
    }
    setTemplateName('')
    setShowNameInput(false)
  }

  const handleBack = async () => {
    await closeSandbox()
    setDraftName('')
    setTemplateName('')
    setShowNameInput(false)
  }

  // Form mode: no machine yet, show config form.
  if (!sandboxMachineId) {
    return (
      <div className="flex flex-col h-[calc(100vh-200px)] min-h-[500px] border rounded-lg overflow-hidden bg-background">
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <button
            onClick={handleBack}
            disabled={isStarting}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Templates
          </button>
          <span className="text-xs text-muted-foreground">New Machine</span>
          <div /> {/* spacer */}
        </div>

        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-md space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1">Configure new machine</h2>
              <p className="text-xs text-muted-foreground">
                {parentTemplate
                  ? <>Based on template <span className="font-medium text-foreground">{parentTemplate.name}</span></>
                  : 'Starting from a clean Ubuntu base layer'}
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Name (optional)</label>
              <input
                type="text"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                placeholder="My dev environment"
                className="w-full text-sm px-2.5 py-1.5 border rounded bg-background mt-1"
                autoFocus
              />
              <p className="text-xs text-muted-foreground mt-1">
                Used as the default name when saving as template.
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Host daemon</label>
              {isLoadingDaemons ? (
                <p className="text-xs text-muted-foreground mt-1">Loading daemons…</p>
              ) : availableDaemons.length === 0 ? (
                <p className="text-xs text-amber-600 border border-amber-500/30 bg-amber-500/10 rounded px-2.5 py-1.5 mt-1">
                  {isPinned
                    ? `This template is pinned to a daemon that's currently offline. Wait for it to reconnect or pair it again.`
                    : 'No daemons online. Pair one in Settings before starting a sandbox.'}
                </p>
              ) : (
                <select
                  value={selectedDaemonId ?? ''}
                  onChange={e => setSelectedDaemonId(e.target.value || null)}
                  disabled={isPinned}
                  className="w-full text-sm px-2.5 py-1.5 border rounded bg-background mt-1 disabled:opacity-60"
                >
                  {availableDaemons.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {isPinned
                  ? 'Template is pinned to this host — its overlay files live there.'
                  : 'Which paired daemon will host this sandbox machine.'}
              </p>
            </div>

            <button
              onClick={handleStart}
              disabled={!canStart}
              className="w-full flex items-center justify-center gap-2 text-sm font-medium px-4 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              {isStarting ? 'Starting...' : 'Start Session'}
            </button>

            {startError && (
              <p className="text-xs text-destructive border border-destructive/30 bg-destructive/10 rounded px-3 py-2">
                {startError}
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Running mode: machine exists, show terminal.
  // Pre-populate Save name with the draft name if user typed one in the form.
  return (
    <div className="flex flex-col h-[calc(100vh-200px)] min-h-[500px] border rounded-lg overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Templates
        </button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{draftName || 'Sandbox session'}</span>
          {parentTemplate && (
            <>
              <span>•</span>
              <span>From: <span className="font-medium text-foreground">{parentTemplate.name}</span></span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showNameInput ? (
            <>
              <input
                type="text"
                value={templateName}
                onChange={e => setTemplateName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                placeholder="New template name..."
                className="text-sm px-2 py-1 border rounded bg-background w-48"
                autoFocus
              />
              <button
                onClick={handleSave}
                disabled={!templateName.trim() || isSaving}
                className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                <Save className="w-3 h-3" />
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => { setShowNameInput(false); setTemplateName('') }}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => { setShowNameInput(true); setTemplateName(draftName) }}
              className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Save className="w-3 h-3" />
              Save as Template
            </button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/30 shrink-0">
          {saveError}
        </div>
      )}

      {/* Terminal */}
      <div className="flex-1 min-h-0">
        <TerminalPanel terminalId={sandboxMachineId} />
      </div>
    </div>
  )
}
