'use client'

import React, { memo, useState } from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Label } from '@/components/ui/label'
import { Slider as RadixSlider } from '@/components/ui/slider'
import { DEFAULT_READING_PREFS, useReadingPrefs, type FontFamily, type TextAlign } from '../lib/reading-prefs'

const READING_WIDTH_MIN = 55
const READING_WIDTH_FULL = 120

const readingWidthToSlider = (width: number) => (width === 0 ? READING_WIDTH_FULL : Math.max(READING_WIDTH_MIN, Math.min(width, READING_WIDTH_FULL - 5)))
const sliderToReadingWidth = (value: number) => (value >= READING_WIDTH_FULL ? 0 : value)
const formatReadingWidth = (value: number) => (value >= READING_WIDTH_FULL ? 'Full' : `${value}ch`)

/**
 * Reading-comfort settings for the markdown preview. Rendered as a Popover
 * (floating panel, no backdrop) rather than a Dialog so the user can see
 * the live preview behind it while adjusting. Two sections:
 *
 *   Basic    — font size, line height, weight, family, paragraph spacing,
 *              reading width. The knobs most people want.
 *   Advanced — letter spacing, text alignment, first-line indent.
 *              Collapsed by default; only power readers touch these.
 *
 * There is NO save button. The store is a Zustand singleton with persist
 * middleware, so `updatePrefs()` writes to localStorage AND re-renders the
 * live preview simultaneously. That fixes the old "I changed it, nothing
 * happened" bug caused by two independent localStorage-backed useStates.
 */
function ReadingPrefsDialogComponent() {
  const { prefs, updatePrefs, resetPrefs } = useReadingPrefs()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const readingWidthSliderValue = readingWidthToSlider(prefs.readingWidth)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="Reading settings"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">Reading settings</div>
            <div className="text-xs text-muted-foreground">
              Changes apply live — no save button.
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            onClick={resetPrefs}
            title="Reset all reading settings"
          >
            Reset all
          </Button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
          <Slider
            label="Font size"
            value={prefs.fontSize}
            min={0.75}
            max={2.5}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => updatePrefs({ fontSize: v })}
            onReset={() => updatePrefs({ fontSize: DEFAULT_READING_PREFS.fontSize })}
          />

          <Slider
            label="Line height"
            value={prefs.lineHeight}
            min={1.0}
            max={2.2}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => updatePrefs({ lineHeight: v })}
            onReset={() => updatePrefs({ lineHeight: DEFAULT_READING_PREFS.lineHeight })}
          />

          <Slider
            label="Font weight"
            value={prefs.fontWeight}
            min={300}
            max={800}
            step={100}
            format={(v) => String(v)}
            onChange={(v) => updatePrefs({ fontWeight: v })}
            onReset={() => updatePrefs({ fontWeight: DEFAULT_READING_PREFS.fontWeight })}
          />

          <Slider
            label="Paragraph spacing"
            value={prefs.paragraphSpacing}
            min={0.4}
            max={2.5}
            step={0.1}
            format={(v) => `${v.toFixed(1)}em`}
            onChange={(v) => updatePrefs({ paragraphSpacing: v })}
            onReset={() => updatePrefs({ paragraphSpacing: DEFAULT_READING_PREFS.paragraphSpacing })}
          />

          <Slider
            label="Reading width"
            value={readingWidthSliderValue}
            min={READING_WIDTH_MIN}
            max={READING_WIDTH_FULL}
            step={5}
            format={formatReadingWidth}
            onChange={(v) => updatePrefs({ readingWidth: sliderToReadingWidth(v) })}
            onReset={() => updatePrefs({ readingWidth: DEFAULT_READING_PREFS.readingWidth })}
          />

          <div className="space-y-2">
            <Label>Font family</Label>
            <div className="grid grid-cols-4 gap-1">
              {(['sans', 'serif', 'mono', 'system'] as FontFamily[]).map(family => (
                <button
                  key={family}
                  type="button"
                  onClick={() => updatePrefs({ fontFamily: family })}
                  className={`rounded border text-xs py-2 capitalize ${
                    prefs.fontFamily === family
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {family}
                </button>
              ))}
            </div>
          </div>

          {/* Advanced — collapsible to keep the dialog approachable. */}
          <div className="rounded border border-gray-200">
            <button
              type="button"
              onClick={() => setAdvancedOpen(o => !o)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <span>Advanced typography</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
            </button>
            {advancedOpen && (
              <div className="space-y-4 border-t border-gray-200 px-3 py-3">
                <Slider
                  label="Letter spacing"
                  value={prefs.letterSpacing}
                  min={-0.05}
                  max={0.2}
                  step={0.01}
                  format={(v) => `${v.toFixed(2)}em`}
                  onChange={(v) => updatePrefs({ letterSpacing: v })}
                  onReset={() => updatePrefs({ letterSpacing: DEFAULT_READING_PREFS.letterSpacing })}
                />

                <Slider
                  label="First-line indent"
                  value={prefs.firstLineIndent}
                  min={0}
                  max={4}
                  step={0.25}
                  format={(v) => `${v.toFixed(2)}em`}
                  onChange={(v) => updatePrefs({ firstLineIndent: v })}
                  onReset={() => updatePrefs({ firstLineIndent: DEFAULT_READING_PREFS.firstLineIndent })}
                />

                <div className="space-y-2">
                  <Label>Text alignment</Label>
                  <div className="grid grid-cols-2 gap-1">
                    {(['left', 'justify'] as TextAlign[]).map(align => (
                      <button
                        key={align}
                        type="button"
                        onClick={() => updatePrefs({ textAlign: align })}
                        className={`rounded border text-xs py-2 capitalize ${
                          prefs.textAlign === align
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                            : 'border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {align}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

      </PopoverContent>
    </Popover>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  onReset?: () => void
}

function Slider({ label, value, min, max, step, format, onChange, onReset }: SliderProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{format(value)}</span>
      </div>
      <RadixSlider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(values) => onChange(values[0])}
        onDoubleClick={onReset}
        title={onReset ? 'Double-click to reset this setting' : undefined}
      />
    </div>
  )
}

export const ReadingPrefsDialog = memo(ReadingPrefsDialogComponent)
