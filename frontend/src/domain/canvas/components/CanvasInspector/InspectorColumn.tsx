'use client'

import React from 'react'
import { cn } from '@/lib/utils'

interface InspectorColumnProps {
  icon?: React.ReactNode
  title: string
  count?: number | string
  accent?: string
  children: React.ReactNode
  className?: string
  headerExtra?: React.ReactNode
  emptyHint?: string
  width?: number
}

export function InspectorColumn({
  icon,
  title,
  count,
  accent,
  children,
  className,
  headerExtra,
  emptyHint,
  width = 180,
}: InspectorColumnProps) {
  return (
    <div
      className={cn('flex min-w-0 flex-col flex-shrink-0 bg-white', className)}
      style={{ width }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon ? <span className={cn('inline-flex items-center', accent)}>{icon}</span> : null}
        <span className="flex-1 truncate">{title}</span>
        {count !== undefined && count !== 0 && count !== '' && (
          <span className="rounded bg-stone-100 px-1.5 py-0.5 font-normal tabular-nums text-stone-600">
            {count}
          </span>
        )}
        {headerExtra}
      </div>
      <div className="border-b border-stone-200" />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {React.Children.count(children) === 0 && emptyHint ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyHint}</div>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

export function InspectorRow({
  className,
  children,
  onClick,
  active,
  title,
  onMouseEnter,
}: {
  className?: string
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  title?: string
  onMouseEnter?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      title={title}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        'hover:bg-stone-100 focus:bg-stone-100 focus:outline-none',
        active && 'bg-emerald-50 hover:bg-emerald-100',
        className,
      )}
    >
      {children}
    </button>
  )
}
