'use client'

import { useEffect } from 'react'
import { Monitor } from 'lucide-react'
import { MachineCenterTabs } from '@/domain/machine-center/components/MachineCenterTabs'
import { useMachineCenterStore } from '@/domain/machine-center/store'

export default function MachinesPage() {
  const fetchTemplates = useMachineCenterStore(s => s.fetchTemplates)
  const fetchSecrets = useMachineCenterStore(s => s.fetchSecrets)

  useEffect(() => {
    fetchTemplates()
    fetchSecrets()
  }, [fetchTemplates, fetchSecrets])

  return (
    <main className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-background">
      <div className="p-2 border-b flex items-center gap-2 bg-card shrink-0">
        <Monitor className="w-4 h-4" />
        <span className="text-sm font-semibold">Machine Center</span>
      </div>
      <div className="flex-1 flex flex-col min-h-0">
        <MachineCenterTabs />
      </div>
    </main>
  )
}
