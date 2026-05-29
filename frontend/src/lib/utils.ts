import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Copy text to clipboard. Tries Clipboard API first, falls back to execCommand. */
export async function copyToClipboard(text: string): Promise<void> {
  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text
  console.info('[copyToClipboard] start', {
    textLength: text.length,
    preview,
    hasClipboardApi: Boolean(navigator.clipboard),
    isSecureContext,
  })

  // Attempt 1: modern Clipboard API (requires secure context)
  try {
    if (navigator.clipboard) {
      console.info('[copyToClipboard] trying navigator.clipboard.writeText')
      await navigator.clipboard.writeText(text)
      console.info('[copyToClipboard] navigator.clipboard.writeText succeeded')
      return
    }
  } catch (error) {
    console.warn('[copyToClipboard] navigator.clipboard.writeText failed, falling back to execCommand', error)
  }

  // Attempt 2: explicit copy event + clipboardData. More reliable than relying
  // on textarea selection alone when Clipboard API is unavailable.
  console.info('[copyToClipboard] trying document.execCommand(\'copy\') with copy-event override')
  let eventCopyWorked = false
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault()
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    eventCopyWorked = true
  }
  document.addEventListener('copy', onCopy)
  const eventOk = document.execCommand('copy')
  document.removeEventListener('copy', onCopy)
  console.info('[copyToClipboard] copy-event execCommand result', { eventOk, eventCopyWorked })
  if (eventOk && eventCopyWorked) {
    return
  }

  // Attempt 3: legacy textarea selection fallback
  console.info('[copyToClipboard] trying document.execCommand(\'copy\') textarea fallback')
  const ta = document.createElement('textarea')
  ta.value = text
  // Must be visible and focusable for execCommand to work
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  console.info('[copyToClipboard] textarea execCommand result', { ok })
  if (!ok) {
    throw new Error('Clipboard unavailable — try HTTPS or localhost')
  }
}
