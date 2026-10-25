import { Button } from '@/components/ui/button'
import { DebouncedInput, DebouncedTextarea } from '@/components/debounced-field'
import type { ResponseContent, ResponseDefinition } from '@/lib/merge'

function newContent(): ResponseContent {
  return { id: crypto.randomUUID(), mediaType: 'application/json', schema: '', example: '' }
}

function newResponse(): ResponseDefinition {
  return { id: crypto.randomUUID(), statusCode: '200', description: 'Successful response', content: [newContent()] }
}

export function ResponseEditor({ responses, readOnly, onChange }: { responses: ResponseDefinition[]; readOnly: boolean; onChange: (responses: ResponseDefinition[]) => void }) {
  const updateResponse = (id: string, patch: Partial<ResponseDefinition>) => onChange(responses.map((response) => response.id === id ? { ...response, ...patch } : response))
  const updateContent = (responseId: string, contentId: string, patch: Partial<ResponseContent>) => onChange(responses.map((response) => response.id === responseId
    ? { ...response, content: response.content.map((item) => item.id === contentId ? { ...item, ...patch } : item) }
    : response))

  return <div className="responses-editor">
    <div className="responses-editor-heading">
      <div><strong>Response contract</strong><span>Document the status codes and payloads the frontend can expect.</span></div>
      <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => onChange([...responses, newResponse()])}>＋ Add response</Button>
    </div>
    {!responses.length && <div className="responses-empty"><strong>No responses documented</strong><span>Add a status code and include a schema or example when available.</span></div>}
    {responses.map((response, index) => <article className="response-definition" key={response.id}>
      <div className="response-definition-heading">
        <label><span>Status</span><DebouncedInput aria-label={`Response ${index + 1} status code`} value={response.statusCode} readOnly={readOnly} maxLength={12} placeholder="200" onValueChange={(value) => updateResponse(response.id, { statusCode: value })} /></label>
        <label className="response-description-field"><span>Description</span><DebouncedInput aria-label={`Response ${index + 1} description`} value={response.description} readOnly={readOnly} maxLength={500} placeholder="Successful response" onValueChange={(value) => updateResponse(response.id, { description: value })} /></label>
        <Button type="button" variant="ghost" size="sm" className="response-remove" aria-label={`Remove response ${response.statusCode || index + 1}`} disabled={readOnly} onClick={() => onChange(responses.filter((item) => item.id !== response.id))}>×</Button>
      </div>
      {response.content.map((item, contentIndex) => <section className="response-content-definition" key={item.id}>
        <div className="response-content-heading">
          <label><span>Content type</span><DebouncedInput aria-label={`Response ${index + 1} content type ${contentIndex + 1}`} value={item.mediaType} readOnly={readOnly} maxLength={160} placeholder="application/json" onValueChange={(value) => updateContent(response.id, item.id, { mediaType: value })} /></label>
          <Button type="button" variant="ghost" size="sm" className="response-remove" aria-label={`Remove content type from response ${response.statusCode || index + 1}`} disabled={readOnly} onClick={() => updateResponse(response.id, { content: response.content.filter((content) => content.id !== item.id) })}>Remove content</Button>
        </div>
        <div className="response-content-fields">
          <label><span>Schema (JSON Schema)</span><DebouncedTextarea aria-label={`Response ${index + 1} schema ${contentIndex + 1}`} className="response-code-editor" value={item.schema} readOnly={readOnly} spellCheck={false} placeholder={'{\n  "type": "object",\n  "properties": {}\n}'} onValueChange={(value) => updateContent(response.id, item.id, { schema: value })} /></label>
          <label><span>Example payload</span><DebouncedTextarea aria-label={`Response ${index + 1} example ${contentIndex + 1}`} className="response-code-editor" value={item.example} readOnly={readOnly} spellCheck={false} placeholder={'{\n  "id": 123\n}'} onValueChange={(value) => updateContent(response.id, item.id, { example: value })} /></label>
        </div>
      </section>)}
      <Button type="button" variant="ghost" size="sm" className="response-add-content" disabled={readOnly} onClick={() => updateResponse(response.id, { content: [...response.content, newContent()] })}>＋ Add content type</Button>
    </article>)}
  </div>
}
