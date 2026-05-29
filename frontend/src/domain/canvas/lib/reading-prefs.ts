'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Global reading preferences for the markdown renderer.
 *
 * Backed by a Zustand store with `persist` middleware so values survive
 * reloads AND sync across every component in the same tab. The previous
 * implementation used a per-hook `useState` with localStorage, which only
 * broadcast via the `storage` event — that event fires for other tabs, NOT
 * the current tab, so changing prefs in the settings dialog left the live
 * preview unchanged until a reload. Bug report: "I changed something, the
 * modal says it saved, but the preview looks identical." Root cause: two
 * independent copies of the same localStorage-backed state.
 *
 * Structure:
 *   - Basic prefs: fontSize, lineHeight, fontFamily, fontWeight, paragraphSpacing, readingWidth
 *   - Advanced prefs: letterSpacing, textAlign, firstLineIndent
 *
 * Adding a new pref = extend `ReadingPrefs` + `DEFAULT_READING_PREFS` and
 * thread it into `MarkdownRenderer`. No migration needed — the persist
 * middleware merges defaults on rehydration via `merge`.
 */

export type FontFamily = 'sans' | 'serif' | 'mono' | 'system'
export type TextAlign = 'left' | 'justify'

export interface ReadingPrefs {
  /** Base font-size multiplier (1.0 = default 14px). */
  fontSize: number
  /** Line-height multiplier applied to paragraphs and list items. */
  lineHeight: number
  /** Character family for the body text. Headings keep sans regardless. */
  fontFamily: FontFamily
  /** Paragraph font weight (400 normal … 700 bold). */
  fontWeight: number
  /** Vertical spacing between paragraphs (in em). */
  paragraphSpacing: number
  /** Max reading width in characters, 0 disables (full width). */
  readingWidth: number

  // ---------- Advanced ----------
  /** Letter spacing in em. Negative = tighter, positive = airier. */
  letterSpacing: number
  /** Paragraph alignment. */
  textAlign: TextAlign
  /** First-line indent in em. 0 = no indent. */
  firstLineIndent: number
}

export const DEFAULT_READING_PREFS: ReadingPrefs = {
  fontSize: 1.0,
  lineHeight: 1.45,
  fontFamily: 'sans',
  fontWeight: 400,
  paragraphSpacing: 1.0,
  readingWidth: 0,
  letterSpacing: 0,
  textAlign: 'left',
  firstLineIndent: 0,
}

const STORAGE_KEY = 'piano:reading-prefs:v2'

interface ReadingPrefsStore {
  prefs: ReadingPrefs
  updatePrefs: (patch: Partial<ReadingPrefs>) => void
  resetPrefs: () => void
}

export const useReadingPrefsStore = create<ReadingPrefsStore>()(
  persist(
    (set) => ({
      prefs: DEFAULT_READING_PREFS,
      updatePrefs: (patch) =>
        set((state) => ({ prefs: { ...state.prefs, ...patch } })),
      resetPrefs: () => set({ prefs: DEFAULT_READING_PREFS }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Merge defaults on rehydration so older payloads without the new
      // fields pick them up instead of rendering with `undefined`.
      merge: (persisted, current) => ({
        ...current,
        prefs: {
          ...DEFAULT_READING_PREFS,
          ...(persisted as ReadingPrefsStore | undefined)?.prefs,
        },
      }),
    },
  ),
)

/**
 * Hook API. Mirrors the previous `useReadingPrefs()` shape so call sites
 * don't change. Everything is reactive: any component that reads `prefs`
 * re-renders when *any* other component calls `updatePrefs`.
 */
export function useReadingPrefs() {
  const prefs = useReadingPrefsStore((s) => s.prefs)
  const updatePrefs = useReadingPrefsStore((s) => s.updatePrefs)
  const resetPrefs = useReadingPrefsStore((s) => s.resetPrefs)
  return { prefs, updatePrefs, resetPrefs }
}

/** Pure helper — resolve a font family preference to a CSS font-family string. */
export const fontFamilyToCss = (family: FontFamily): string => {
  switch (family) {
    case 'serif':
      return '"Charter", "Georgia", "Times New Roman", serif'
    case 'mono':
      return '"JetBrains Mono", "Fira Code", "Courier New", monospace'
    case 'system':
      return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    case 'sans':
    default:
      return 'inherit'
  }
}
