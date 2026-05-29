/**
 * True when a KeyboardEvent originated inside something the user is typing
 * into — input, textarea, or contenteditable. Canvas-level shortcuts
 * universally bail in this case so we never steal a real keystroke.
 */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return (
    t instanceof HTMLInputElement
    || t instanceof HTMLTextAreaElement
    || !!t?.isContentEditable
    // CJK / dead-key composition: skip while the IME is mid-character.
    || e.isComposing
  )
}
