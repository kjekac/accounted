'use client'

import type { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

/**
 * Client wrapper that organizes the page's supporting detail into tabs so the
 * booking map stays the hero and the rest doesn't stack into a long scroll.
 * Content is server-rendered upstream and handed in as ReactNode slots.
 */
export function KnowledgeTabs({
  tabs,
}: {
  tabs: { value: string; label: string; content: ReactNode }[]
}) {
  if (tabs.length === 0) return null
  return (
    <Tabs defaultValue={tabs[0].value} className="space-y-6">
      <TabsList>
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="space-y-8 focus-visible:outline-none">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
