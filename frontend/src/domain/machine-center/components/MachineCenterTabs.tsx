'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TemplatesTab } from './TemplatesTab'
import { MissionControlTab } from './MissionControlTab'
import { SecretsTab } from './SecretsTab'

export function MachineCenterTabs() {
  return (
    <Tabs defaultValue="templates" className="w-full flex-1 flex flex-col min-h-0">
      <TabsList className="self-start mt-6 mx-8">
        <TabsTrigger value="templates">Templates</TabsTrigger>
        <TabsTrigger value="mission-control">Mission Control</TabsTrigger>
        <TabsTrigger value="secrets">Secrets & Configs</TabsTrigger>
      </TabsList>

      {/* Templates and Secrets use a centered max-width container because they're lists. */}
      <TabsContent value="templates" className="flex-1 min-h-0 overflow-y-auto px-8 pb-6 pt-4">
        <div className="max-w-5xl mx-auto">
          <TemplatesTab />
        </div>
      </TabsContent>

      {/* Mission Control manages its own layout so the bottom terminal panel can span full width. */}
      <TabsContent value="mission-control" className="flex-1 min-h-0 flex flex-col">
        <MissionControlTab />
      </TabsContent>

      <TabsContent value="secrets" className="flex-1 min-h-0 overflow-y-auto px-8 pb-6 pt-4">
        <div className="max-w-5xl mx-auto">
          <SecretsTab />
        </div>
      </TabsContent>
    </Tabs>
  )
}
