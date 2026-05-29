'use client'

import { useMachineCenterStore } from '../store'
import { TemplateCard } from './TemplateCard'
import { SandboxPanel } from './SandboxPanel'
import { Spinner } from '@/components/ui/spinner'
import { Plus } from 'lucide-react'

export function TemplatesTab() {
  const templates = useMachineCenterStore(s => s.templates)
  const isLoading = useMachineCenterStore(s => s.isLoadingTemplates)
  const isSandboxOpen = useMachineCenterStore(s => s.isSandboxOpen)
  const openSandboxForm = useMachineCenterStore(s => s.openSandboxForm)
  const deleteTemplate = useMachineCenterStore(s => s.deleteTemplate)

  // When sandbox is active, the entire tab content becomes the sandbox panel.
  if (isSandboxOpen) {
    return <SandboxPanel />
  }

  const systemTemplates = templates.filter(t => t.isSystem)
  const userTemplates = templates.filter(t => !t.isSystem)

  const getParentName = (parentId: string | null) => {
    if (!parentId) return undefined
    return templates.find(t => t.id === parentId)?.name
  }

  return (
    <div className="space-y-6">
      {/* Quick action: create a blank machine from base layer (no template) */}
      <section>
        <button
          onClick={() => openSandboxForm()}
          className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-border hover:border-foreground/40 hover:bg-accent rounded-lg w-full text-left transition-colors group"
        >
          <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
            <Plus className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">New Machine</div>
            <div className="text-xs text-muted-foreground">Your machine, clean state. All changes stay in the sandbox.</div>
          </div>
        </button>
      </section>

      {systemTemplates.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">System Templates</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {systemTemplates.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                onFork={() => openSandboxForm(t.id)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3">Your Templates</h2>
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : userTemplates.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No templates yet. Click <span className="font-medium text-foreground">+ New Machine</span> above to start a sandbox, customize it, and save it as a template.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {userTemplates.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                parentName={getParentName(t.parentTemplateId)}
                onFork={() => openSandboxForm(t.id)}
                onDelete={() => {
                  if (confirm(`Delete template "${t.name}"? This cannot be undone.`)) {
                    deleteTemplate(t.id)
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
