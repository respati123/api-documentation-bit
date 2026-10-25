import * as SelectPrimitive from '@radix-ui/react-select'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-950 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 disabled:opacity-50',
        'graphite-select-trigger', className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="select-chevron" aria-hidden>⌄</SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        className={cn('z-50 min-w-[8rem] overflow-hidden rounded-lg border border-slate-200 bg-white p-1 text-slate-950 shadow-lg', 'graphite-select-content', className)}
        position="popper"
        sideOffset={6}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex min-h-10 select-none items-center rounded-md py-2 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-blue-50 data-[highlighted]:text-blue-950',
        'graphite-select-item', className
      )}
      {...props}
    >
      <span className="absolute left-3 text-blue-700"><SelectPrimitive.ItemIndicator>✓</SelectPrimitive.ItemIndicator></span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}
