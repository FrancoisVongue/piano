'use client'

import React, { useState, useEffect } from 'react'
import { Zap, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Action } from '@piano/shared'

interface PlayDropdownButtonProps {
  onPlay: (actionId: string) => void
  actions: Action.Model[] // Actions passed from parent (fetched once globally)
  disabled?: boolean
  variant?: 'default' | 'outline'
  size?: 'sm' | 'default' | 'lg'
  className?: string
}

export function PlayDropdownButton({
  onPlay,
  actions,
  disabled = false,
  variant = 'default',
  size = 'sm',
  className,
}: PlayDropdownButtonProps) {
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null)

  // Auto-select first action when actions load
  useEffect(() => {
    if (actions.length > 0 && !selectedActionId) {
      setSelectedActionId(actions[0].id)
    }
  }, [actions, selectedActionId])

  const selectedAction = selectedActionId 
    ? actions.find(a => a.id === selectedActionId)
    : actions[0]

  const handleMainClick = () => {
    if (selectedActionId) {
      onPlay(selectedActionId)
    }
  }

  // Don't render if no actions
  if (actions.length === 0) {
    return null
  }

  return (
    <div className={cn('inline-flex rounded-md shadow-sm', className)}>
      {/* Main action button */}
      <Button
        onClick={handleMainClick}
        disabled={disabled || !selectedActionId}
        variant={variant}
        size={size}
        className="rounded-r-none border-r-0 min-w-[90px] max-w-[140px]"
      >
        <Zap className="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
        <span className="truncate">
          {selectedAction?.name || 'Select Action'}
        </span>
      </Button>

      {/* Dropdown selector */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            disabled={disabled}
            variant={variant}
            size={size}
            className={cn(
              "rounded-l-none px-2",
              variant === 'default' && "border-l border-l-primary-foreground/20",
              variant === 'outline' && "border-l border-l-input"
            )}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.id}
              onClick={() => setSelectedActionId(action.id)}
              className={cn(
                'cursor-pointer',
                selectedActionId === action.id && 'bg-accent'
              )}
            >
              <Zap className="w-3.5 h-3.5 mr-2" />
              {action.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
