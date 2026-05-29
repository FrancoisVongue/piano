'use client'

import { MachineTemplate } from '@piano/shared'
import { GitFork, Trash2 } from 'lucide-react'

type Props = {
  template: MachineTemplate.Model
  parentName?: string
  onFork: () => void
  onDelete?: () => void
}

export function TemplateCard({ template, parentName, onFork, onDelete }: Props) {
  return (
    <div className="border rounded-lg p-4 flex flex-col gap-2 hover:border-foreground/30 transition-colors">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">{template.icon || '📦'}</span>
          <h3 className="font-medium text-sm">{template.name}</h3>
        </div>
        {!template.isSystem && onDelete && (
          <button
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive transition-colors p-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {template.description && (
        <p className="text-xs text-muted-foreground">{template.description}</p>
      )}

      {parentName && (
        <span className="text-xs text-muted-foreground">
          Derived from: {parentName}
        </span>
      )}

      <button
        onClick={onFork}
        className="mt-auto flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors self-start"
      >
        <GitFork className="w-3 h-3" />
        Fork
      </button>
    </div>
  )
}
