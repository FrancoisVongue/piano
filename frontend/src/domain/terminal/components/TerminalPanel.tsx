'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Terminal as TerminalProtocol } from '@piano/shared'
import { API_CONFIG, SSE_CONFIG, TERMINAL_CONFIG } from '@/config'
import { attachTerminalClipboard } from '../lib/clipboard'

// Default route: backend proxy. Next.js's `rewrites` only proxy HTTP, so we
// can't rely on the relative-through-proxy path (`API_CONFIG.BASE_URL` is
// empty in dev). Use the same absolute backend URL SSE already targets and
// just swap the scheme to ws(s)://. Daemon-direct override kicks in only when
// NEXT_PUBLIC_TERMINAL_DAEMON_URL is explicitly set.
function defaultTerminalUrl(machineId: string): string {
  if (TERMINAL_CONFIG.DIRECT_DAEMON_URL) {
    return `${TERMINAL_CONFIG.DIRECT_DAEMON_URL.replace(/\/+$/, '')}/ws?machineId=${encodeURIComponent(machineId)}`
  }
  const httpBase = API_CONFIG.BASE_URL
    || SSE_CONFIG.BASE_URL
    || (typeof window !== 'undefined' ? window.location.origin : '')
  const base = httpBase.replace(/^http/, 'ws').replace(/\/+$/, '')
  return `${base}/api/terminal/${encodeURIComponent(machineId)}`
}

type TerminalPanelProps = {
  terminalId: string
  daemonUrl?: string
  contextContent?: string
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void
  // Extra buttons (drag-out, close-pane) rendered in the same top-right
  // chrome cluster as the font-size controls. Lets the pane host
  // (MachineWindow) co-locate all per-pane affordances in one block.
  chromeExtras?: React.ReactNode
}

const CONNECTION_TIMEOUT_MS = 10_000
const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 20
const FONT_SIZE_STORAGE_KEY = 'piano-terminal-font-size'

export default function TerminalPanel({ terminalId, daemonUrl, contextContent, onStatusChange, chromeExtras }: TerminalPanelProps) {
  const termContainerRef = useRef<HTMLDivElement>(null)
  const onStatusChangeRef = useRef(onStatusChange)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  onStatusChangeRef.current = onStatusChange
  const [fontSize, setFontSize] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
    const saved = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)
    const parsed = saved ? Number.parseInt(saved, 10) : DEFAULT_FONT_SIZE
    return Number.isFinite(parsed) ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, parsed)) : DEFAULT_FONT_SIZE
  })

  const updateFontSize = useCallback((next: number) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, next))
    setFontSize(clamped)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(clamped))
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    if (!term || !fitAddon) return
    term.options.fontSize = fontSize
    requestAnimationFrame(() => fitAddon.fit())
  }, [fontSize])

  useEffect(() => {
    const container = termContainerRef.current
    if (!container) return

    let active = true

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10_000,
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    termRef.current = term
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(container)
    requestAnimationFrame(() => fitAddon.fit())

    // Copy/paste lives in one place (../lib/clipboard) — see there for the
    // cross-platform key bindings and the secure/insecure-context handling.
    const clipboard = attachTerminalClipboard(term)
    term.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true

      const fromClipboard = clipboard.handleKey(e)
      if (fromClipboard !== undefined) return fromClipboard

      // Swallow MachineWindow shortcuts (new tab / close pane / files / split)
      // so xterm doesn't emit ^T/^W/^B/^D — returning false lets the event keep
      // bubbling to MachineBody's window listener. macOS uses Cmd (passed
      // through by xterm), so no swallow needed there.
      const key = e.key.toLowerCase()
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
      if (!isMac && e.ctrlKey && e.shiftKey && ['t', 'w', 'b', 'd'].includes(key)) {
        return false
      }

      return true
    })

    term.writeln('\x1b[90mConnecting to daemon...\x1b[0m')
    onStatusChangeRef.current?.('connecting')

    const wsUrl = daemonUrl
      ? `${daemonUrl.replace(/\/+$/, '')}/ws?machineId=${encodeURIComponent(terminalId)}`
      : defaultTerminalUrl(terminalId)
    console.log(`[Machine ${terminalId}] Connecting to ${wsUrl}`)

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      console.error(`[Machine ${terminalId}] Invalid WebSocket URL:`, err)
      term.writeln('\x1b[31m Invalid daemon URL\x1b[0m')
      onStatusChangeRef.current?.('disconnected')
      return () => { term.dispose() }
    }

    ws.binaryType = 'arraybuffer'
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let alive = false

    // Connection timeout: if no message received within N seconds, give up.
    const timeoutId = setTimeout(() => {
      if (!alive && active) {
        console.warn(`[Machine ${terminalId}] Connection timed out (${CONNECTION_TIMEOUT_MS}ms)`)
        term.writeln('\x1b[31m Connection timed out\x1b[0m')
        term.writeln('\x1b[90mDaemon did not respond. Is it running?\x1b[0m')
        onStatusChangeRef.current?.('disconnected')
        ws.close()
      }
    }, CONNECTION_TIMEOUT_MS)

    ws.onopen = () => {
      if (!active) return
      alive = true
      clearTimeout(timeoutId)
      console.log(`[Machine ${terminalId}] Connected`)
      onStatusChangeRef.current?.('connected')
      term.writeln('\x1b[32m Connected\x1b[0m')

      // Write parent node context into the machine's filesystem.
      if (contextContent) {
        ws.send(TerminalProtocol.encode({ type: 'file', path: 'context.md', data: contextContent }))
      }
    }

    let replayDone = false
    let onDataDisposable: { dispose: () => void } | null = null

    // Drop xterm.js's auto-generated replies to terminal capability queries.
    // The daemon now answers these queries LOCALLY (see answerTerminalQueries
    // in daemon/machine.go) so that programs like nvim get their responses
    // within microseconds, well before they time out. The xterm.js replies
    // that travel back through the WebSocket would arrive ~100ms later — too
    // late for short-lived TUI commands (e.g. `nvim -c 'wq'`), and by then
    // the shell is at its prompt and the replies would show up as garbage
    // (`11;rgb:1a1a/1b1b/2626`, `1$r0m`, `1;2c` etc.) that the zsh line
    // editor mangles from escape sequences into visible characters.
    //
    // So: the daemon handles the fast path for programs, this filter handles
    // the cleanup for the late-arriving second copy. Both are needed; one
    // without the other regresses.
    const isQueryResponse = (data: string) =>
      /^\x1b\[\??[\d;]*[cR]$/.test(data) ||                    // DA1/DA2 response, cursor position
      /^\x1b\[>[\d;]*c$/.test(data) ||                         // DA2 response
      /^\x1b\][\d]+;rgb:[\da-f/]+(\x07|\x1b\\)$/.test(data) || // OSC color response
      /^\x1b\[\?[\d;]+\$y$/.test(data) ||                      // DECRPM mode response
      /^\x1bP[^\x1b]*\x1b\\$/.test(data)                       // DCS response

    const wireInput = () => {
      if (onDataDisposable) return // already wired
      onDataDisposable = term.onData((value) => {
        if (isQueryResponse(value)) return // daemon already answered locally
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(TerminalProtocol.encode({ type: 'input', data: value }))
        }
      })
    }

    const restoreCursor = () => {
      term.options.cursorBlink = true
      term.write('\x1b[?25h')
    }

    ws.onmessage = (event) => {
      if (!active) return
      const text =
        event.data instanceof ArrayBuffer
          ? decoder.decode(event.data, { stream: true })
          : event.data

      // Detect replay-done marker — strip it and wire up input.
      if (!replayDone && typeof text === 'string' && text.includes('\x1b]piano:replay-done')) {
        replayDone = true
        const cleaned = text.replace(/\x1b]piano:replay-done(?::first-connect)?\x07/, '')
        if (cleaned) term.write(cleaned)
        setTimeout(() => {
          restoreCursor()
          wireInput()
        }, 0)
        return
      }

      term.write(text)
    }

    ws.onclose = (event) => {
      if (!active) return
      clearTimeout(timeoutId)
      console.warn(`[Machine ${terminalId}] Closed (code=${event.code}, clean=${event.wasClean}, reason=${event.reason || 'none'})`)
      onStatusChangeRef.current?.('disconnected')
      if (!alive) {
        // Server-set close reason (e.g. "Daemon paused — resume it in Settings.")
        // is more useful than the generic fallback when the backend bothered to send one.
        const reason = event.reason || 'Is the daemon running? Check the URL.'
        term.writeln(`\x1b[31m Connection failed\x1b[0m \x1b[90m(code=${event.code})\x1b[0m`)
        term.writeln(`\x1b[90m${reason}\x1b[0m`)
      } else {
        term.writeln('\r\n\x1b[90m-- Connection closed --\x1b[0m')
      }
    }

    ws.onerror = () => {
      if (!active) return
      console.error(`[Machine ${terminalId}] WebSocket error`)
    }

    let resizeDebounceId: ReturnType<typeof setTimeout> | null = null
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if (resizeDebounceId) clearTimeout(resizeDebounceId)
      resizeDebounceId = setTimeout(() => {
        resizeDebounceId = null
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(TerminalProtocol.encode({ type: 'resize', cols, rows }))
        }
      }, 200)
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit())
    })
    resizeObserver.observe(container)

    return () => {
      console.log(`[Machine ${terminalId}] Cleanup`)
      active = false
      clearTimeout(timeoutId)
      if (resizeDebounceId) clearTimeout(resizeDebounceId)
      resizeObserver.disconnect()
      onDataDisposable?.dispose()
      onResizeDisposable.dispose()
      clipboard.dispose()
      ws.close()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [terminalId, daemonUrl, contextContent])

  return (
    <div className="relative w-full h-full min-h-[300px]" style={{ backgroundColor: '#1a1b26' }}>
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-white/10 bg-black/30 px-1 py-1 backdrop-blur-sm">
        {chromeExtras}
        {chromeExtras ? <div className="mx-0.5 h-4 w-px bg-white/10" /> : null}
        <button
          type="button"
          className="h-6 w-6 rounded text-xs font-medium text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => updateFontSize(fontSize - 1)}
          title="Smaller font"
        >
          -
        </button>
        <span className="min-w-[2.5rem] text-center text-[10px] font-medium text-gray-400">
          {fontSize}px
        </span>
        <button
          type="button"
          className="h-6 w-6 rounded text-xs font-medium text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => updateFontSize(fontSize + 1)}
          title="Larger font"
        >
          +
        </button>
        <div className="mx-0.5 h-4 w-px bg-white/10" />
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => requestAnimationFrame(() => fitAddonRef.current?.fit())}
          title="Fix display"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <div
        ref={termContainerRef}
        className="w-full h-full min-h-[300px]"
        style={{ backgroundColor: '#1a1b26' }}
      />
    </div>
  )
}
