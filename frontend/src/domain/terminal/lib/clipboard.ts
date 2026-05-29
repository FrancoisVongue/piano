import type { Terminal } from '@xterm/xterm'

// Terminal clipboard, done the way real terminal emulators do it.
//
// Two hard facts shape this:
//   1. In a terminal, Ctrl+C = SIGINT and Ctrl+V = literal-quote (^V), so we
//      can't naively map them to copy/paste — we must intercept.
//   2. The async `navigator.clipboard` API only exists in a secure context
//      (HTTPS / localhost); over plain HTTP it's `undefined`. The synchronous
//      clipboard DOM events (`paste`/`copy`) work everywhere with no permission.
//
// So: PASTE is read from the native `paste` event (works on HTTP); the key
// handler only suppresses xterm's ^V. COPY writes via `navigator.clipboard`
// when available, falling back to `execCommand` otherwise.
//
// Convenient, cross-platform bindings (matching Windows Terminal / VS Code):
//   Paste — Cmd+V (mac) · Ctrl+V / Ctrl+Shift+V (win/linux)
//   Copy  — Cmd+C (mac) · Ctrl+Shift+C, or plain Ctrl+C *with a selection*
//           (win/linux). Bare Ctrl+C with nothing selected stays SIGINT.

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

async function writeClipboard(text: string): Promise<void> {
  if (!text) return
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // secure API present but rejected (focus/permission) — fall through
    }
  }
  // Insecure-context fallback: the legacy but universally-available path.
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    // nothing more we can do without a secure context
  }
  ta.remove()
}

export type TerminalClipboard = {
  // Call from the terminal's custom key-event handler. Returns `false` when the
  // key was a copy/paste shortcut we handled (caller returns false to xterm),
  // or `undefined` when it isn't a clipboard key (caller keeps handling it).
  handleKey: (e: KeyboardEvent) => boolean | undefined
  dispose: () => void
}

export function attachTerminalClipboard(term: Terminal): TerminalClipboard {
  // PASTE: the native event carries the text via clipboardData (no permission,
  // works on plain HTTP). Capture phase + stopImmediatePropagation means xterm's
  // own paste handler never also fires → exactly one insert. preventDefault
  // stops the text from landing in the helper textarea too.
  const onPaste = (ev: ClipboardEvent) => {
    const text = ev.clipboardData?.getData('text/plain')
    if (!text) return
    term.paste(text)
    ev.preventDefault()
    ev.stopImmediatePropagation()
  }
  term.textarea?.addEventListener('paste', onPaste, true)

  const handleKey = (e: KeyboardEvent): boolean | undefined => {
    if (e.altKey) return undefined
    const key = e.key.toLowerCase()
    const mod = isMac ? e.metaKey : e.ctrlKey

    // Paste — suppress ^V; the `paste` event above does the actual insert.
    if (key === 'v' && mod) return false

    // Copy — the terminal's selection → clipboard.
    if (key === 'c' && mod) {
      const explicit = isMac || e.shiftKey // Cmd+C / Ctrl+Shift+C
      if (explicit || term.hasSelection()) {
        if (term.hasSelection()) {
          void writeClipboard(term.getSelection())
          term.clearSelection()
        }
        return false // handled — never reaches the shell as ^C
      }
      // bare Ctrl+C, nothing selected → fall through to SIGINT
    }

    return undefined
  }

  return {
    handleKey,
    dispose: () => term.textarea?.removeEventListener('paste', onPaste, true),
  }
}
