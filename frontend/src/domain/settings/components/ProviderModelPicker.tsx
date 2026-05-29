'use client'

import React from 'react'
import { UserApiKey, LLM } from '@piano/shared'
import { cn } from '@/lib/utils'

// Inline checkbox list for picking which of a provider's models the user
// wants visible in their canvas dropdown. Selection is eager: each tick
// fires the mutation immediately. No save button — the list IS the state.

interface Props {
  providerKey: UserApiKey.Model
  onToggle: (nextIds: string[]) => void
  disabled?: boolean
}

export function ProviderModelPicker({ providerKey, onToggle, disabled }: Props) {
  const models = LLM.getModelsByProvider(providerKey.provider)
  const enabled = new Set(providerKey.enabledModelIds)

  const toggle = (modelId: string) => {
    const next = new Set(enabled)
    next.has(modelId) ? next.delete(modelId) : next.add(modelId)
    onToggle([...next])
  }

  if (models.length === 0) return null

  return (
    <div className="mt-2 pl-7 flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Models</span>
      {models.map(model => {
        const checked = enabled.has(model.id)
        return (
          <label
            key={model.id}
            className={cn(
              'flex items-center gap-2 text-sm rounded px-1.5 py-1',
              'hover:bg-muted/70 cursor-pointer transition-colors',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(model.id)}
              className="accent-emerald-500"
            />
            <span className="font-medium">{model.name}</span>
            <span className="text-xs text-muted-foreground truncate">{model.id}</span>
          </label>
        )
      })}
    </div>
  )
}
