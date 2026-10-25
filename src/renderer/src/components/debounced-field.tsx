import type { ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useDebouncedEditorValue } from '@/components/variable-field'

type DebouncedInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}

type DebouncedTextareaProps = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}

export function DebouncedInput({ value, onValueChange, onBlur, onKeyDown, ...props }: DebouncedInputProps) {
  const [draft, updateDraft, flushDraft] = useDebouncedEditorValue(value, onValueChange)
  return <Input
    {...props}
    value={draft}
    onChange={(event) => updateDraft(event.target.value)}
    onBlur={(event) => { flushDraft(); onBlur?.(event) }}
    onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') flushDraft(); onKeyDown?.(event) }}
  />
}

export function DebouncedTextarea({ value, onValueChange, onBlur, onKeyDown, ...props }: DebouncedTextareaProps) {
  const [draft, updateDraft, flushDraft] = useDebouncedEditorValue(value, onValueChange)
  return <Textarea
    {...props}
    value={draft}
    onChange={(event) => updateDraft(event.target.value)}
    onBlur={(event) => { flushDraft(); onBlur?.(event) }}
    onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') flushDraft(); onKeyDown?.(event) }}
  />
}
