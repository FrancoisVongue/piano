'use client'

import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react'
import { X as XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Levenshtein distance between two strings (case-insensitive). */
function levenshtein(a: string, b: string): number {
  const al = a.toLowerCase(), bl = b.toLowerCase()
  const m = al.length, n = bl.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = i - 1
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = al[i - 1] === bl[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return dp[n]
}

interface TagsEditorProps {
  /** Current tags */
  value: string[]
  /** Called every time the tag list changes */
  onChange: (tags: string[]) => void
  placeholder?: string
  /** Visual variant — inline is borderless (for embedding inside other panels);
   *  boxed has its own border + padding (for standalone dialogs). */
  variant?: 'inline' | 'boxed'
  /** Autofocus the input on mount */
  autoFocus?: boolean
  /** Compact size for dropdowns/popovers */
  size?: 'sm' | 'md'
  /** Show a small "tag suggestions" row below — optional history of known tags */
  suggestions?: string[]
  className?: string
}

/**
 * Chip-based tag editor.
 *
 * Design lifted from the existing NoteCard tag input so arrangement-level,
 * note-level, and any other future tagging surface all share one interaction
 * model (press Enter to add, comma to add, Backspace on empty to pop last,
 * click × to remove). Lives in `components/` (not a domain folder) because
 * tags are a cross-cutting concern.
 */
export function TagsEditor({
  value,
  onChange,
  placeholder = 'Add tag…',
  variant = 'boxed',
  autoFocus = false,
  size = 'md',
  suggestions,
  className,
}: TagsEditorProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const addTag = useCallback((raw: string) => {
    const tag = raw.trim()
    if (!tag) return
    if (value.includes(tag)) return
    onChange([...value, tag])
  }, [value, onChange])

  const removeTag = useCallback((tag: string) => {
    onChange(value.filter(t => t !== tag))
  }, [value, onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
      setInput('')
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      e.preventDefault()
      onChange(value.slice(0, -1))
    }
  }, [input, value, addTag, onChange])

  const handleBlur = useCallback(() => {
    // Commit whatever the user typed when focus leaves — Enter isn't the only exit.
    if (input.trim()) {
      addTag(input)
      setInput('')
    }
  }, [input, addTag])

  // Fuzzy-matched suggestions: ranked by Levenshtein distance when typing,
  // otherwise show all unused tags as flat chips.
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const availableTags = useMemo(
    () => (suggestions ?? []).filter(s => !value.includes(s)),
    [suggestions, value],
  )

  const fuzzyMatches = useMemo(() => {
    const q = input.trim()
    if (!q || availableTags.length === 0) return []
    const maxDist = Math.max(2, Math.floor(q.length * 0.6))
    return availableTags
      .map(tag => ({ tag, dist: levenshtein(q, tag) }))
      .filter(({ tag, dist }) => dist <= maxDist || tag.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8)
  }, [input, availableTags])

  // Reset highlight when matches change
  useEffect(() => setHighlightIdx(-1), [fuzzyMatches.length])

  const selectSuggestion = useCallback((tag: string) => {
    addTag(tag)
    setInput('')
    inputRef.current?.focus()
  }, [addTag])

  const handleKeyDownWrapped = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Arrow navigation in dropdown
    if (fuzzyMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIdx(i => Math.min(i + 1, fuzzyMatches.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIdx(i => Math.max(i - 1, 0))
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && highlightIdx >= 0) {
        e.preventDefault()
        selectSuggestion(fuzzyMatches[highlightIdx].tag)
        return
      }
    }
    handleKeyDown(e)
  }, [fuzzyMatches, highlightIdx, selectSuggestion, handleKeyDown])

  return (
    <div
      className={cn(
        'relative flex flex-wrap items-center gap-1',
        variant === 'boxed' && 'px-2 py-2 rounded-md border bg-white border-gray-200',
        size === 'sm' && 'gap-0.5',
        className,
      )}
    >
      {value.map(tag => (
        <span
          key={tag}
          className={cn(
            'inline-flex items-center gap-1 rounded bg-blue-100 text-blue-800 font-medium',
            size === 'sm' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs',
          )}
        >
          {tag}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeTag(tag) }}
            className="hover:text-red-600 focus:outline-none"
            tabIndex={-1}
            aria-label={`Remove tag ${tag}`}
          >
            <XIcon className={size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDownWrapped}
        onBlur={handleBlur}
        placeholder={value.length === 0 ? placeholder : ''}
        maxLength={50}
        className={cn(
          'flex-1 min-w-[60px] bg-transparent outline-none border-none',
          size === 'sm' ? 'text-[11px]' : 'text-sm',
        )}
      />

      {/* Fuzzy dropdown — appears while typing */}
      {fuzzyMatches.length > 0 && (
        <div className="absolute left-0 top-full mt-1 w-full bg-white border border-gray-200 rounded-md shadow-md z-50 py-1">
          {fuzzyMatches.map(({ tag }, i) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(tag) }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-sm',
                i === highlightIdx ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-50',
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Static suggestions row — shown when NOT typing */}
      {!input.trim() && availableTags.length > 0 && (
        <div className="w-full flex flex-wrap gap-1 pt-2 mt-1 border-t border-gray-100">
          <span className={cn('text-gray-400', size === 'sm' ? 'text-[9px]' : 'text-[10px]')}>Existing:</span>
          {availableTags.slice(0, 10).map(tag => (
            <button
              key={tag}
              type="button"
              onClick={() => selectSuggestion(tag)}
              className={cn(
                'rounded bg-gray-100 text-gray-600 hover:bg-gray-200',
                size === 'sm' ? 'px-1 text-[9px]' : 'px-1.5 py-0.5 text-[10px]',
              )}
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
