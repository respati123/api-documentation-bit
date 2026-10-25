import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-36 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm text-slate-950 shadow-sm transition-colors placeholder:text-slate-500 focus-visible:border-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700/20 disabled:cursor-not-allowed disabled:opacity-50',
        'graphite-textarea', className
      )}
      {...props}
    />
  )
})
