import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FocusEvent, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export type VariableSuggestion = { name: string; scope: string; value?: string; secret?: boolean }

type CommonProps = {
  value: string
  onValueChange: (value: string) => void
  suggestions: VariableSuggestion[]
  onVariableClick: (name: string, sourceValue: string) => void
}

type InputProps = CommonProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>
type TextareaProps = CommonProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>

type Match = { start: number; cursor: number; prefix: string }
type MenuPosition = { left: number; top: number; width: number }

export function useDebouncedEditorValue(value: string, onValueChange: (value: string) => void, delay = 250, maxWait = 1000): [string, (value: string) => void, () => void] {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const parentValueRef = useRef(value)
  const callbackRef = useRef(onValueChange)
  const pendingRef = useRef(false)
  const debounceTimerRef = useRef<number | undefined>(undefined)
  const maxWaitTimerRef = useRef<number | undefined>(undefined)
  callbackRef.current = onValueChange

  const clearTimers = useCallback(() => {
    if (debounceTimerRef.current !== undefined) window.clearTimeout(debounceTimerRef.current)
    if (maxWaitTimerRef.current !== undefined) window.clearTimeout(maxWaitTimerRef.current)
    debounceTimerRef.current = undefined
    maxWaitTimerRef.current = undefined
  }, [])
  const flush = useCallback(() => {
    if (!pendingRef.current) return
    pendingRef.current = false
    clearTimers()
    parentValueRef.current = draftRef.current
    callbackRef.current(draftRef.current)
  }, [clearTimers])
  const update = useCallback((nextValue: string) => {
    draftRef.current = nextValue
    setDraft(nextValue)
    pendingRef.current = true
    if (debounceTimerRef.current !== undefined) window.clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = window.setTimeout(flush, delay)
    if (maxWaitTimerRef.current === undefined) maxWaitTimerRef.current = window.setTimeout(flush, maxWait)
  }, [delay, flush, maxWait])

  useEffect(() => {
    if (value === parentValueRef.current) return
    parentValueRef.current = value
    if (value === draftRef.current) return
    pendingRef.current = false
    clearTimers()
    draftRef.current = value
    setDraft(value)
  }, [value, clearTimers])
  useEffect(() => () => clearTimers(), [clearTimers])

  return [draft, update, flush]
}

function getMatch(value: string, cursor: number): Match | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/\{\{\s*([\w.-]*)$/)
  if (!match || match.index === undefined) return null
  return { start: match.index, cursor, prefix: match[1] }
}

function getMenuPosition(element: HTMLElement): MenuPosition {
  const rect = element.getBoundingClientRect()
  const width = Math.min(Math.max(rect.width, 220), 300, window.innerWidth - 16)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  const estimatedHeight = 230
  const top = window.innerHeight - rect.bottom < estimatedHeight && rect.top > estimatedHeight
    ? Math.max(8, rect.top - estimatedHeight - 4)
    : Math.min(window.innerHeight - 8, rect.bottom + 4)
  return { left, top, width }
}

function getVariableTooltip(item: VariableSuggestion | undefined, name: string, masked = false): string {
  if (!item) return `Variable ${name} is not defined. Click to add it.`
  if (item.secret || masked) return `${name} · ${item.scope}\nValue hidden`
  return `${name} · ${item.scope}\n${item.value ? `Value: ${item.value}` : 'Value is empty'}`
}

function renderVariableText(value: string, suggestions: VariableSuggestion[], onClick: (name: string) => void, masked: boolean) {
  if (!value.includes('{{')) return masked ? '•'.repeat(value.length) : value
  const knownNames = new Set(suggestions.map((item) => item.name))
  const suggestionByName = new Map(suggestions.map((item) => [item.name, item]))
  const tokens = /\{\{\s*([^{}]+?)\s*\}\}/g
  const parts: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tokens.exec(value))) {
    const name = match[1].trim()
    const prefix = value.slice(cursor, match.index)
    if (prefix) parts.push(<span key={`text-${cursor}`}>{masked ? '•'.repeat(prefix.length) : prefix}</span>)
    const known = knownNames.has(name)
    parts.push(<span
      key={`variable-${match.index}`}
      className={cn('variable-token', !known && 'variable-token-missing')}
      title={getVariableTooltip(known ? suggestionByName.get(name) : undefined, name, masked)}
      onClick={(event) => { event.stopPropagation(); onClick(name) }}
    >{`{{${name}}}`}</span>)
    cursor = match.index + match[0].length
  }
  const suffix = value.slice(cursor)
  if (suffix) parts.push(<span key={`text-${cursor}`}>{masked ? '•'.repeat(suffix.length) : suffix}</span>)
  return parts
}

function useVariableField(value: string, onValueChange: (value: string) => void, suggestions: VariableSuggestion[]) {
  const elementRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const [match, setMatch] = useState<Match | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const filtered = useMemo(() => {
    if (!match) return []
    const query = match.prefix.toLowerCase()
    return suggestions.filter((item) => item.name.toLowerCase().startsWith(query)).slice(0, 8)
  }, [match, suggestions])

  function syncMatch(element: HTMLInputElement | HTMLTextAreaElement) {
    elementRef.current = element
    const next = getMatch(element.value, element.selectionStart ?? element.value.length)
    setMatch(next)
    setSelectedIndex(0)
    if (next) setPosition(getMenuPosition(element))
  }

  useLayoutEffect(() => {
    const element = elementRef.current
    const overlay = overlayRef.current
    if (!element || !overlay) return
    const style = getComputedStyle(element)
    overlay.style.fontFamily = element instanceof HTMLInputElement && element.type === 'password'
      ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
      : style.fontFamily
    overlay.style.fontSize = style.fontSize
    overlay.style.fontWeight = style.fontWeight
    overlay.style.fontStyle = style.fontStyle
    overlay.style.lineHeight = style.lineHeight
    overlay.style.letterSpacing = style.letterSpacing
    overlay.style.textTransform = style.textTransform
    overlay.style.paddingTop = style.paddingTop
    overlay.style.paddingRight = style.paddingRight
    overlay.style.paddingBottom = style.paddingBottom
    overlay.style.paddingLeft = style.paddingLeft
    overlay.style.tabSize = style.tabSize
    overlay.scrollTop = element.scrollTop
    overlay.scrollLeft = element.scrollLeft
  }, [value])

  useEffect(() => {
    if (!match) return
    const update = () => {
      if (elementRef.current) setPosition(getMenuPosition(elementRef.current))
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [match])

  function choose(name: string) {
    const element = elementRef.current
    if (!element || !match) return
    const nextValue = `${value.slice(0, match.start)}{{${name}}}${value.slice(match.cursor)}`
    const cursor = match.start + name.length + 4
    onValueChange(nextValue)
    setMatch(null)
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(cursor, cursor)
    })
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, userHandler?: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void) {
    userHandler?.(event)
    if (event.defaultPrevented || !match || !filtered.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setSelectedIndex((current) => (current + direction + filtered.length) % filtered.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      choose(filtered[selectedIndex]?.name ?? filtered[0].name)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setMatch(null)
    }
  }

  function onScroll(element: HTMLInputElement | HTMLTextAreaElement) {
    if (overlayRef.current) {
      overlayRef.current.scrollTop = element.scrollTop
      overlayRef.current.scrollLeft = element.scrollLeft
    }
    if (match) setPosition(getMenuPosition(element))
  }

  return { elementRef, overlayRef, menuId, match, filtered, selectedIndex, position, syncMatch, choose, onKeyDown, onScroll, setMatch }
}

function SuggestionsMenu({ id, items, selectedIndex, position, onChoose }: { id: string; items: VariableSuggestion[]; selectedIndex: number; position: MenuPosition | null; onChoose: (name: string) => void }) {
  if (!items.length || !position) return null
  return createPortal(<div id={id} className="variable-suggestions" role="listbox" aria-label="Environment variable suggestions" style={position}>
    {items.map((item, index) => <button
      type="button"
      role="option"
      id={`${id}-option-${index}`}
      aria-selected={index === selectedIndex}
      className={cn('variable-suggestion', index === selectedIndex && 'variable-suggestion-active')}
      key={`${item.scope}-${item.name}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onChoose(item.name)}
    ><span className="variable-suggestion-mark">{'{{'}</span><span className="variable-suggestion-name">{item.name}</span><span className="variable-suggestion-scope">{item.scope}</span></button>)}
  </div>, document.body)
}

export function VariableInput({ value, onValueChange, suggestions, onVariableClick, className, onFocus, onBlur, onKeyDown, onScroll, type = 'text', ...props }: InputProps) {
  const [draft, updateDraft, flushDraft] = useDebouncedEditorValue(value, onValueChange)
  const field = useVariableField(draft, updateDraft, suggestions)
  const masked = type === 'password'
  return <div className={cn('variable-field', 'variable-field-input', field.match && 'variable-field-open')}>
    <Input
      {...props}
      ref={(element) => { field.elementRef.current = element }}
      type={type}
      className={cn('variable-field-control', masked && 'variable-password-control', className)}
      value={draft}
      onChange={(event) => { updateDraft(event.target.value); field.syncMatch(event.target) }}
      onFocus={(event) => { onFocus?.(event); field.syncMatch(event.currentTarget) }}
      onBlur={(event) => { flushDraft(); onBlur?.(event); field.setMatch(null) }}
      onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') flushDraft(); field.onKeyDown(event, onKeyDown) }}
      onScroll={(event) => { onScroll?.(event); field.onScroll(event.currentTarget) }}
      role="combobox"
      aria-haspopup="listbox"
      aria-controls={field.menuId}
      aria-activedescendant={field.match && field.filtered.length ? `${field.menuId}-option-${field.selectedIndex}` : undefined}
      aria-autocomplete="list"
      aria-expanded={Boolean(field.match && field.filtered.length)}
    />
    <div ref={field.overlayRef} className="variable-field-overlay variable-input-overlay" aria-hidden="true">
      {renderVariableText(draft, suggestions, (name) => onVariableClick(name, draft), masked)}
    </div>
    <SuggestionsMenu id={field.menuId} items={field.filtered} selectedIndex={field.selectedIndex} position={field.position} onChoose={field.choose} />
  </div>
}

export function VariableTextarea({ value, onValueChange, suggestions, onVariableClick, className, onFocus, onBlur, onKeyDown, onScroll, ...props }: TextareaProps) {
  const [draft, updateDraft, flushDraft] = useDebouncedEditorValue(value, onValueChange)
  const field = useVariableField(draft, updateDraft, suggestions)
  return <div className={cn('variable-field', 'variable-field-textarea', field.match && 'variable-field-open')}>
    <Textarea
      {...props}
      ref={(element) => { field.elementRef.current = element }}
      className={cn('variable-field-control', 'variable-textarea-control', className)}
      value={draft}
      onChange={(event) => { updateDraft(event.target.value); field.syncMatch(event.target) }}
      onFocus={(event) => { onFocus?.(event); field.syncMatch(event.currentTarget) }}
      onBlur={(event) => { flushDraft(); onBlur?.(event); field.setMatch(null) }}
      onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') flushDraft(); field.onKeyDown(event, onKeyDown) }}
      onScroll={(event) => { onScroll?.(event); field.onScroll(event.currentTarget) }}
      role="combobox"
      aria-haspopup="listbox"
      aria-controls={field.menuId}
      aria-activedescendant={field.match && field.filtered.length ? `${field.menuId}-option-${field.selectedIndex}` : undefined}
      aria-autocomplete="list"
      aria-expanded={Boolean(field.match && field.filtered.length)}
    />
    <div ref={field.overlayRef} className="variable-field-overlay variable-textarea-overlay" aria-hidden="true">
      {renderVariableText(draft, suggestions, (name) => onVariableClick(name, draft), false)}
    </div>
    <SuggestionsMenu id={field.menuId} items={field.filtered} selectedIndex={field.selectedIndex} position={field.position} onChoose={field.choose} />
  </div>
}

type VariableUrlFieldProps = CommonProps & {
  className?: string
  readOnly?: boolean
  placeholder?: string
  spellCheck?: boolean
  'aria-label'?: string
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void
}

function getEditableValue(editor: HTMLDivElement): string {
  return Array.from(editor.childNodes).map((node) => node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.variableToken === 'true'
    ? (node as HTMLElement).dataset.tokenValue ?? node.textContent ?? ''
    : node.textContent ?? '').join('')
}

function hasPlainVariable(editor: HTMLDivElement): boolean {
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g
  return Array.from(editor.childNodes).some((node) => {
    if (node.nodeType !== Node.TEXT_NODE) return false
    pattern.lastIndex = 0
    return pattern.test(node.textContent ?? '')
  })
}

function hasRenderedVariable(editor: HTMLDivElement): boolean {
  return Array.from(editor.children).some((node) => (node as HTMLElement).dataset.variableToken === 'true')
}

function getEditorNodeLength(node: Node): number {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.variableToken === 'true'
    ? (node as HTMLElement).dataset.tokenValue?.length ?? node.textContent?.length ?? 0
    : node.textContent?.length ?? 0
}

function getEditableCaretOffset(editor: HTMLDivElement): number {
  const selection = window.getSelection()
  const anchor = selection?.anchorNode
  if (!selection || !anchor || !editor.contains(anchor) && anchor !== editor) return getEditableValue(editor).length
  let offset = 0
  if (anchor === editor) {
    for (let index = 0; index < Math.min(selection.anchorOffset, editor.childNodes.length); index += 1) offset += getEditorNodeLength(editor.childNodes[index])
    return offset
  }
  for (const child of Array.from(editor.childNodes)) {
    if (child === anchor) return offset + (child.nodeType === Node.TEXT_NODE ? selection.anchorOffset : 0)
    if (child.contains(anchor)) return offset
    offset += getEditorNodeLength(child)
  }
  return offset
}

function setEditableCaretOffset(editor: HTMLDivElement, requestedOffset: number) {
  const selection = window.getSelection()
  if (!selection) return
  let offset = Math.max(0, requestedOffset)
  const children = Array.from(editor.childNodes)
  let consumed = 0
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    const length = getEditorNodeLength(child)
    if (child.nodeType === Node.TEXT_NODE) {
      if (offset <= consumed + length) {
        const range = document.createRange()
        range.setStart(child, Math.max(0, Math.min(length, offset - consumed)))
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
    } else if ((child as HTMLElement).dataset.variableToken === 'true') {
      if (offset <= consumed) {
        const range = document.createRange()
        range.setStartBefore(child)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
      if (offset < consumed + length || offset === consumed + length) {
        const range = document.createRange()
        range.setStartAfter(child)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
    }
    consumed += length
  }
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

function adjacentVariableToken(editor: HTMLDivElement, selection: Selection, direction: 'backward' | 'forward'): HTMLElement | null {
  if (!selection.isCollapsed) return null
  const anchor = selection.anchorNode
  if (!anchor) return null
  let childIndex = -1
  if (anchor === editor) {
    childIndex = direction === 'backward' ? selection.anchorOffset - 1 : selection.anchorOffset
  } else if (anchor.parentNode === editor && anchor.nodeType === Node.TEXT_NODE) {
    const textLength = anchor.textContent?.length ?? 0
    if (direction === 'backward' && selection.anchorOffset === 0) childIndex = Array.prototype.indexOf.call(editor.childNodes, anchor) - 1
    if (direction === 'forward' && selection.anchorOffset === textLength) childIndex = Array.prototype.indexOf.call(editor.childNodes, anchor) + 1
  }
  const candidate = editor.childNodes[childIndex]
  return candidate?.nodeType === Node.ELEMENT_NODE && (candidate as HTMLElement).dataset.variableToken === 'true' ? candidate as HTMLElement : null
}

function renderEditableVariables(editor: HTMLDivElement, value: string, suggestions: VariableSuggestion[]) {
  const knownNames = new Set(suggestions.map((item) => item.name))
  const suggestionByName = new Map(suggestions.map((item) => [item.name, item]))
  const tokens = /\{\{\s*([^{}]+?)\s*\}\}/g
  const parts: Node[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tokens.exec(value))) {
    const name = match[1].trim()
    if (match.index > cursor) parts.push(document.createTextNode(value.slice(cursor, match.index)))
    const known = knownNames.has(name)
    const token = document.createElement('span')
    token.className = cn('variable-token', 'variable-url-token', !known && 'variable-token-missing')
    token.contentEditable = 'false'
    token.dataset.variableToken = 'true'
    token.dataset.tokenValue = match[0]
    token.title = getVariableTooltip(known ? suggestionByName.get(name) : undefined, name)
    token.textContent = `{{${name}}}`
    parts.push(token)
    cursor = match.index + match[0].length
  }
  if (cursor < value.length) parts.push(document.createTextNode(value.slice(cursor)))
  editor.replaceChildren(...parts)
}

export function VariableUrlField({ value, onValueChange, suggestions, onVariableClick, className, readOnly = false, placeholder, spellCheck = false, 'aria-label': ariaLabel, onBlur }: VariableUrlFieldProps) {
  const [draft, updateDraft, flushDraft] = useDebouncedEditorValue(value, onValueChange)
  const editorRef = useRef<HTMLDivElement>(null)
  const suggestionKey = JSON.stringify(suggestions.map(({ name, scope, value, secret }) => [name, scope, value, secret]))
  const previousSuggestionKey = useRef<string | null>(null)
  const menuId = useId()
  const [match, setMatch] = useState<Match | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const filtered = useMemo(() => {
    if (!match) return []
    return suggestions.filter((item) => item.name.toLowerCase().startsWith(match.prefix.toLowerCase())).slice(0, 8)
  }, [match, suggestions])

  function updateSuggestions(editor: HTMLDivElement) {
    const nextValue = getEditableValue(editor)
    const nextMatch = getMatch(nextValue, getEditableCaretOffset(editor))
    setMatch(nextMatch)
    setSelectedIndex(0)
    if (nextMatch) setPosition(getMenuPosition(editor))
  }

  function syncFromEditor(editor: HTMLDivElement) {
    const nextValue = getEditableValue(editor)
    const caretOffset = getEditableCaretOffset(editor)
    if (!nextValue && editor.childNodes.length) {
      editor.replaceChildren()
      setEditableCaretOffset(editor, 0)
    } else if (hasPlainVariable(editor)) {
      renderEditableVariables(editor, nextValue, suggestions)
      setEditableCaretOffset(editor, caretOffset)
    }
    updateDraft(nextValue)
    const nextMatch = getMatch(nextValue, caretOffset)
    setMatch(nextMatch)
    setSelectedIndex(0)
    if (nextMatch) setPosition(getMenuPosition(editor))
  }

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const suggestionsChanged = previousSuggestionKey.current !== suggestionKey
    const needsRender = getEditableValue(editor) !== draft || (suggestionsChanged && (hasPlainVariable(editor) || hasRenderedVariable(editor)))
    previousSuggestionKey.current = suggestionKey
    if (!needsRender) return
    const isFocused = document.activeElement === editor
    const caretOffset = getEditableCaretOffset(editor)
    renderEditableVariables(editor, draft, suggestions)
    if (isFocused) setEditableCaretOffset(editor, caretOffset)
  }, [draft, suggestionKey])

  useEffect(() => {
    if (!match) return
    const update = () => { if (editorRef.current) setPosition(getMenuPosition(editorRef.current)) }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [match])

  function chooseSuggestion(name: string) {
    const editor = editorRef.current
    if (!editor || !match) return
    const currentValue = getEditableValue(editor)
    const nextValue = `${currentValue.slice(0, match.start)}{{${name}}}${currentValue.slice(match.cursor)}`
    const caretOffset = match.start + name.length + 4
    renderEditableVariables(editor, nextValue, suggestions)
    setEditableCaretOffset(editor, caretOffset)
    updateDraft(nextValue)
    setMatch(null)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const editor = editorRef.current
    if (!editor) return
    if (event.ctrlKey && event.key === 'Enter') flushDraft()
    if (match && filtered.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setSelectedIndex((current) => (current + direction + filtered.length) % filtered.length)
      return
    }
    if (match && filtered.length && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault()
      chooseSuggestion(filtered[selectedIndex]?.name ?? filtered[0].name)
      return
    }
    if (event.key === 'Escape' && match) {
      event.preventDefault()
      setMatch(null)
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const selection = window.getSelection()
      const token = selection && adjacentVariableToken(editor, selection, event.key === 'Backspace' ? 'backward' : 'forward')
      if (token) {
        event.preventDefault()
        const currentOffset = getEditableCaretOffset(editor)
        const deletedLength = getEditorNodeLength(token)
        token.remove()
        const nextValue = getEditableValue(editor)
        const caretOffset = event.key === 'Backspace' ? Math.max(0, currentOffset - deletedLength) : currentOffset
        setEditableCaretOffset(editor, caretOffset)
        updateDraft(nextValue)
        setMatch(getMatch(nextValue, caretOffset))
      }
      return
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault()
      flushDraft()
      editor.closest('form')?.requestSubmit()
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault()
    const editor = editorRef.current
    if (!editor) return
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!range || !editor.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== editor) return
    const text = event.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' ')
    range.deleteContents()
    const textNode = document.createTextNode(text)
    range.insertNode(textNode)
    range.setStartAfter(textNode)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    syncFromEditor(editor)
  }

  return <>
    <div
      ref={editorRef}
      className={cn('variable-url-editor', 'url-input', className)}
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-controls={menuId}
      aria-activedescendant={match && filtered.length ? `${menuId}-option-${selectedIndex}` : undefined}
      aria-autocomplete="list"
      aria-expanded={Boolean(match && filtered.length)}
      aria-readonly={readOnly}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck={spellCheck}
      data-placeholder={placeholder}
      onInput={(event) => syncFromEditor(event.currentTarget)}
      onFocus={(event) => updateSuggestions(event.currentTarget)}
      onBlur={(event) => { flushDraft(); onBlur?.(event); setMatch(null) }}
      onClick={(event) => {
        const token = (event.target as HTMLElement).closest<HTMLElement>('[data-variable-token="true"]')
        if (!token) return
        const name = (token.dataset.tokenValue ?? '').match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1]?.trim()
        if (name) onVariableClick(name, getEditableValue(event.currentTarget))
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    />
    <SuggestionsMenu id={menuId} items={filtered} selectedIndex={selectedIndex} position={position} onChoose={chooseSuggestion} />
  </>
}
