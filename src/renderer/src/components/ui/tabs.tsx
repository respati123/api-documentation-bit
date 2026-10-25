import * as TabsPrimitive from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex min-h-11 items-center gap-1 rounded-lg bg-slate-100 p-1', 'graphite-tabs-list', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'min-h-9 rounded-md px-4 text-sm font-medium text-slate-600 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 data-[state=active]:bg-white data-[state=active]:font-semibold data-[state=active]:text-slate-950 data-[state=active]:shadow-sm',
        'graphite-tab', className
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('min-h-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700', className)}
      {...props}
    />
  )
}
