import { parse, stringify } from 'yaml'
import type { BodyField, BodyMode, HeaderField, ParamField, RequestAuth, ResponseContent, ResponseDefinition, SyncRequest, SyncTreeNode } from './merge'

type OpenApiObject = Record<string, unknown>
type ParsedRequest = { request: SyncRequest; tags: string[] }

const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const

function record(value: unknown): OpenApiObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as OpenApiObject : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function resolveReference(spec: OpenApiObject, value: unknown): OpenApiObject | null {
  const object = record(value)
  const reference = asString(object?.$ref)
  if (!reference.startsWith('#/')) return object
  const resolved = reference.slice(2).split('/').reduce<unknown>((current, part) => record(current)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
  return record(resolved)
}

function schemaExample(spec: OpenApiObject, value: unknown, depth = 0, seen = new Set<string>()): unknown {
  const schema = record(value)
  if (!schema || depth > 6) return null
  const reference = asString(schema.$ref)
  if (reference) {
    if (seen.has(reference)) return null
    const nextSeen = new Set(seen).add(reference)
    return schemaExample(spec, resolveReference(spec, schema), depth + 1, nextSeen)
  }
  if ('example' in schema) return schema.example
  if ('default' in schema) return schema.default
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  const type = asString(schema.type)
  if (type === 'object' || record(schema.properties)) {
    const properties = record(schema.properties) ?? {}
    return Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, schemaExample(spec, property, depth + 1, seen)]))
  }
  if (type === 'array') return [schemaExample(spec, schema.items, depth + 1, seen)]
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'null') return null
  return ''
}

function sampleValue(spec: OpenApiObject, media: OpenApiObject): unknown {
  if ('example' in media) return media.example
  const examples = record(media.examples)
  const firstExample = examples ? record(Object.values(examples)[0]) : null
  if (firstExample && 'value' in firstExample) return firstExample.value
  return schemaExample(spec, media.schema)
}

function variableSyntax(value: string, toOpenApi: boolean): string {
  return toOpenApi
    ? value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, '{$1}')
    : value.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, '{{$1}}')
}

function serverUrl(spec: OpenApiObject, value: unknown): string {
  const server = resolveReference(spec, value)
  const variables = record(server?.variables) ?? {}
  return asString(server?.url).replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const defaultValue = record(variables[name])?.default
    return typeof defaultValue === 'string' ? defaultValue : `{{${name}}}`
  }).replace(/\/$/, '')
}

function parameterFields(spec: OpenApiObject, rawParameters: unknown[]): { params: ParamField[]; pathParams: ParamField[]; headers: HeaderField[] } {
  const params: ParamField[] = []
  const pathParams: ParamField[] = []
  const headers: HeaderField[] = []
  for (const raw of rawParameters) {
    const parameter = resolveReference(spec, raw)
    if (!parameter) continue
    const name = asString(parameter.name).trim()
    const location = asString(parameter.in)
    if (!name || !['path', 'query', 'header'].includes(location)) continue
    const example = 'example' in parameter ? parameter.example : schemaExample(spec, parameter.schema)
    const row = { id: crypto.randomUUID(), name, value: example == null ? '' : typeof example === 'string' ? example : JSON.stringify(example) ?? String(example), enabled: true, ...(asString(parameter.description) ? { description: asString(parameter.description) } : {}) }
    if (location === 'path') pathParams.push(row)
    else if (location === 'query') params.push(row)
    else headers.push(row)
  }
  return { params, pathParams, headers }
}

function bodyFromRequest(spec: OpenApiObject, raw: unknown): Pick<SyncRequest, 'body' | 'bodyMode' | 'bodyFields' | 'bodyMimeType'> {
  const requestBody = resolveReference(spec, raw)
  const content = record(requestBody?.content)
  if (!content) return { body: '', bodyMode: 'none' }
  const mediaType = Object.keys(content).sort((a, b) => (a === 'application/json' ? -1 : b === 'application/json' ? 1 : 0))[0]
  if (!mediaType) return { body: '', bodyMode: 'none' }
  const media = record(content[mediaType]) ?? {}
  const sample = sampleValue(spec, media)
  const schema = record(media.schema) ?? {}
  if (asString(schema.format) === 'binary' || mediaType === 'application/octet-stream') return { body: '', bodyMode: 'file', bodyMimeType: mediaType }
  if (mediaType === 'application/x-www-form-urlencoded' || mediaType === 'multipart/form-data') {
    const fields: BodyField[] = Object.entries(record(schema.properties) ?? {}).map(([name, property]) => {
      const fieldSchema = record(property) ?? {}
      const value = record(sample)?.[name] ?? schemaExample(spec, property)
      const isFile = asString(fieldSchema.format) === 'binary' || asString(fieldSchema.format) === 'base64'
      return { id: crypto.randomUUID(), name, value: value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value), enabled: true, type: isFile ? 'file' : 'text' }
    })
    return { body: '', bodyMode: mediaType === 'multipart/form-data' ? 'form-data' : 'urlencoded', bodyFields: fields }
  }
  const mode: BodyMode = mediaType.includes('json') ? 'json'
    : mediaType.includes('xml') ? 'xml'
      : mediaType.includes('yaml') ? 'yaml'
        : mediaType.includes('edn') ? 'edn'
          : 'other'
  const body = sample == null ? '' : typeof sample === 'string' ? sample : mode === 'yaml' ? stringify(sample).trimEnd() : JSON.stringify(sample, null, 2)
  return { body, bodyMode: mode, ...(mode === 'other' ? { bodyMimeType: mediaType } : {}) }
}

function responseExampleText(value: unknown, mediaType: string): string {
  if (mediaType.toLowerCase().includes('json')) {
    try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
}

function responsesFromOperation(spec: OpenApiObject, raw: unknown): ResponseDefinition[] {
  const responses = record(raw) ?? {}
  return Object.entries(responses).map(([statusCode, rawResponse]) => {
    const response = resolveReference(spec, rawResponse) ?? {}
    const contents = record(response.content) ?? {}
    const content: ResponseContent[] = Object.entries(contents).map(([mediaType, rawMedia]) => {
      const media = record(rawMedia) ?? {}
      const namedExamples = record(media.examples)
      const firstNamedExample = namedExamples ? record(Object.values(namedExamples)[0]) : null
      const example = 'example' in media
        ? media.example
        : firstNamedExample && 'value' in firstNamedExample
          ? firstNamedExample.value
          : 'schema' in media ? schemaExample(spec, media.schema) : undefined
      const schema = 'schema' in media ? JSON.stringify(media.schema, null, 2) ?? '' : ''
      return {
        id: crypto.randomUUID(),
        mediaType,
        schema,
        example: example === undefined ? '' : responseExampleText(example, mediaType)
      }
    })
    return {
      id: crypto.randomUUID(),
      statusCode,
      description: asString(response.description),
      content
    }
  })
}

function referencedResponseSchemas(spec: OpenApiObject, responses: ResponseDefinition[]): Record<string, unknown> | undefined {
  const available = record(record(spec.components)?.schemas) ?? {}
  const included: Record<string, unknown> = {}
  const pending: string[] = []
  const findReferences = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(findReferences); return }
    const object = record(value)
    if (!object) return
    const reference = asString(object.$ref)
    if (reference.startsWith('#/components/schemas/')) {
      const name = reference.slice('#/components/schemas/'.length).split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~')
      if (name) pending.push(name)
    }
    Object.values(object).forEach(findReferences)
  }
  for (const response of responses) for (const content of response.content) {
    if (!content.schema) continue
    try { findReferences(JSON.parse(content.schema)) } catch { /* Imported OpenAPI schemas are already parsed values. */ }
  }
  while (pending.length) {
    const name = pending.pop() as string
    if (Object.hasOwn(included, name) || !Object.hasOwn(available, name)) continue
    const schema = available[name]
    included[name] = schema
    findReferences(schema)
  }
  return Object.keys(included).length ? included : undefined
}

function rewriteSchemaReferences(value: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteSchemaReferences(item, mapping))
  const object = record(value)
  if (!object) return value
  return Object.fromEntries(Object.entries(object).map(([key, item]) => {
    if (key === '$ref' && typeof item === 'string' && item.startsWith('#/components/schemas/')) {
      const [, , , ...path] = item.split('/')
      const originalName = path.shift()?.replace(/~1/g, '/').replace(/~0/g, '~') ?? ''
      const renamed = mapping.get(originalName)
      const suffix = path.length ? `/${path.join('/')}` : ''
      return [key, renamed ? `#/components/schemas/${renamed.replace(/~/g, '~0').replace(/\//g, '~1')}${suffix}` : item]
    }
    return [key, rewriteSchemaReferences(item, mapping)]
  }))
}

type ComponentSchemaRegistry = { schemas: Record<string, unknown>; mappings: Map<string, Map<string, string>> }

function componentSchemaRegistry(requests: SyncRequest[]): ComponentSchemaRegistry {
  const schemas: Record<string, unknown> = {}
  const sourceMappings = new Map<string, Map<string, string>>()
  const mappings = new Map<string, Map<string, string>>()
  for (const request of requests) {
    const source = request.openApiSchemas
    if (!source || !Object.keys(source).length) continue
    const sourceKey = JSON.stringify(source)
    if (sourceMappings.has(sourceKey)) {
      mappings.set(request.id, sourceMappings.get(sourceKey) as Map<string, string>)
      continue
    }
    const mapping = new Map<string, string>()
    for (const name of Object.keys(source)) {
      let candidate = name
      let suffix = 2
      while (Object.hasOwn(schemas, candidate)) candidate = `${name}_${suffix++}`
      mapping.set(name, candidate)
    }
    for (const [name, schema] of Object.entries(source)) {
      const target = mapping.get(name) as string
      schemas[target] = rewriteSchemaReferences(schema, mapping)
    }
    sourceMappings.set(sourceKey, mapping)
    mappings.set(request.id, mapping)
  }
  return { schemas, mappings }
}

function exportedResponseContent(request: SyncRequest, response: ResponseDefinition, registry: ComponentSchemaRegistry): Record<string, unknown> | undefined {
  const content: Record<string, unknown> = {}
  for (const item of response.content) {
    const mediaType = item.mediaType.trim()
    if (!mediaType) {
      if (item.schema.trim() || item.example.trim()) throw new Error(`Response ${response.statusCode} has a schema or example without a content type.`)
      continue
    }
    if (Object.hasOwn(content, mediaType)) throw new Error(`Response ${response.statusCode} lists content type "${mediaType}" more than once.`)
    const media: Record<string, unknown> = {}
    if (item.schema.trim()) {
      let schema: unknown
      try { schema = JSON.parse(item.schema) } catch { throw new Error(`The schema for response ${response.statusCode} must be valid JSON.`) }
      media.schema = rewriteSchemaReferences(schema, registry.mappings.get(request.id) ?? new Map())
    }
    if (item.example.trim()) {
      if (mediaType.toLowerCase().includes('json')) {
        try { media.example = JSON.parse(item.example) } catch { media.example = item.example }
      } else media.example = item.example
    }
    content[mediaType] = media
  }
  return Object.keys(content).length ? content : undefined
}

function exportedResponses(request: SyncRequest, registry: ComponentSchemaRegistry): Record<string, unknown> {
  const defined = request.responses ?? []
  if (!defined.length) return { '200': { description: 'Successful response' } }
  const responses: Record<string, unknown> = {}
  for (const response of defined) {
    const statusCode = response.statusCode.trim()
    if (!/^(?:[1-5]\d\d|[1-5][xX]{2}|default)$/.test(statusCode)) throw new Error(`Response status "${statusCode}" must be a status code, 2XX-style range, or default.`)
    if (responses[statusCode]) throw new Error(`Response status "${statusCode}" is listed more than once.`)
    const content = exportedResponseContent(request, response, registry)
    responses[statusCode] = {
      description: response.description.trim() || 'Response',
      ...(content ? { content } : {})
    }
  }
  return responses
}

function authFromSecurity(spec: OpenApiObject, rawSecurity: unknown): RequestAuth {
  if (!Array.isArray(rawSecurity) || !rawSecurity.length) return { type: 'none' }
  const schemes = record(record(spec.components)?.securitySchemes) ?? {}
  for (const requirementValue of rawSecurity) {
    const requirement = record(requirementValue)
    if (!requirement) continue
    for (const name of Object.keys(requirement)) {
      const scheme = resolveReference(spec, schemes[name])
      if (!scheme) continue
      if (scheme.type === 'http' && scheme.scheme === 'bearer') return { type: 'bearer', token: '' }
      if (scheme.type === 'http' && scheme.scheme === 'basic') return { type: 'basic', username: '', password: '' }
      if (scheme.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query')) return { type: 'api-key', name: asString(scheme.name), value: '', location: scheme.in }
    }
  }
  return { type: 'none' }
}

function uniqueRequestName(operation: OpenApiObject, method: string, path: string): string {
  return asString(operation.summary) || asString(operation.operationId) || `${method.toUpperCase()} ${path}`
}

export function importOpenApi(text: string): { tree: SyncTreeNode[]; title: string; requestCount: number } {
  let parsed: unknown
  try { parsed = parse(text) } catch (error) {
    throw new Error(error instanceof Error ? `Could not parse the OpenAPI file: ${error.message}` : 'Could not parse the OpenAPI file.')
  }
  const spec = record(parsed)
  if (!spec || !/^3\.(0|1)\./.test(asString(spec.openapi)) || !record(spec.paths)) {
    throw new Error('Choose an OpenAPI 3.0 or 3.1 document with a paths object.')
  }
  const info = record(spec.info)
  const rootServer = record(Array.isArray(spec.servers) ? spec.servers[0] : null)
  const rootServerUrl = serverUrl(spec, rootServer)
  const parsedRequests: ParsedRequest[] = []
  const paths = record(spec.paths) ?? {}
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = resolveReference(spec, pathItemValue)
    if (!pathItem) continue
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : []
    for (const method of methods) {
      const operation = record(pathItem[method])
      if (!operation) continue
      const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : []
      const fields = parameterFields(spec, [...pathParameters, ...operationParameters])
      const endpoint = variableSyntax(path, false)
      const operationServer = record(Array.isArray(operation.servers) ? operation.servers[0] : null)
      const localServer = operationServer ? serverUrl(spec, operationServer) : rootServerUrl
      const url = asString(operation['x-api-documentation-request-url']) || `${localServer}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
      const documentation = asString(operation.description)
      const responses = responsesFromOperation(spec, operation.responses)
      const openApiSchemas = referencedResponseSchemas(spec, responses)
      const request: SyncRequest = {
        id: crypto.randomUUID(), kind: 'request', name: uniqueRequestName(operation, method, path), method: method.toUpperCase(), url,
        body: '', bodyMode: 'none', headers: fields.headers, params: fields.params, pathParams: fields.pathParams,
        auth: authFromSecurity(spec, operation.security ?? spec.security),
        responses,
        ...(openApiSchemas ? { openApiSchemas } : {}),
        ...(documentation ? { documentation } : {}),
        ...(operation.deprecated === true ? { deprecated: true } : {}),
        ...(asString(operation['x-api-documentation-deprecation-reason']) ? { deprecationReason: asString(operation['x-api-documentation-deprecation-reason']) } : {}),
        ...bodyFromRequest(spec, operation.requestBody)
      }
      parsedRequests.push({ request, tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()) : [] })
    }
  }
  if (!parsedRequests.length) throw new Error('No supported HTTP operations were found in the OpenAPI paths.')
  const tree: SyncTreeNode[] = []
  const folders = new Map<string, Extract<SyncTreeNode, { kind: 'folder' }>>()
  for (const { request, tags } of parsedRequests) {
    const tag = tags[0]
    if (!tag) tree.push(request)
    else {
      let folder = folders.get(tag)
      if (!folder) {
        folder = { id: crypto.randomUUID(), kind: 'folder', name: tag, children: [] }
        folders.set(tag, folder)
        tree.push(folder)
      }
      folder.children.push(request)
    }
  }
  return { tree, title: asString(info?.title, 'Imported OpenAPI'), requestCount: parsedRequests.length }
}

function flattenRequests(tree: SyncTreeNode[], parentFolders: string[] = []): Array<{ request: SyncRequest; tags: string[] }> {
  return tree.flatMap((node) => node.kind === 'folder'
    ? flattenRequests(node.children, [...parentFolders, node.name])
    : [{ request: node, tags: parentFolders.slice(-1) }])
}

function requestRoute(url: string): { path: string; server?: string } {
  const absolute = url.match(/^(https?:\/\/[^/?#]+)([^?#]*)/i)
  if (absolute) return { server: absolute[1], path: variableSyntax(absolute[2] || '/', true) }
  const path = url.split(/[?#]/, 1)[0] || '/'
  return { path: variableSyntax(path.startsWith('/') ? path : `/${path}`, true) }
}

function queryParams(request: SyncRequest): ParamField[] {
  const explicit = [...(request.params ?? [])]
  const query = request.url.match(/[?]([^#]*)/)
  if (!query) return explicit
  for (const [name, value] of new URLSearchParams(query[1]).entries()) {
    if (!explicit.some((param) => param.name === name && param.value === value)) explicit.push({ id: crypto.randomUUID(), name, value, enabled: true })
  }
  return explicit
}

function bodyContent(request: SyncRequest): Record<string, unknown> | undefined {
  const mode = request.bodyMode ?? (request.body.trim() ? 'json' : 'none')
  if (mode === 'none') return undefined
  if (mode === 'file') {
    const mediaType = request.bodyMimeType || 'application/octet-stream'
    return { [mediaType]: { schema: { type: 'string', format: 'binary' } } }
  }
  if (mode === 'form-data' || mode === 'urlencoded') {
    const mediaType = mode === 'form-data' ? 'multipart/form-data' : 'application/x-www-form-urlencoded'
    const properties: Record<string, unknown> = {}
    const example: Record<string, unknown> = {}
    for (const field of request.bodyFields ?? []) {
      if (!field.enabled || !field.name) continue
      properties[field.name] = field.type === 'file' ? { type: 'string', format: 'binary' } : { type: 'string' }
      example[field.name] = field.value
    }
    return { [mediaType]: { schema: { type: 'object', properties }, example } }
  }
  const mediaType = mode === 'json' || mode === 'graphql' ? 'application/json'
    : mode === 'xml' ? 'application/xml'
      : mode === 'yaml' ? 'application/yaml'
        : mode === 'edn' ? 'application/edn'
          : request.bodyMimeType || 'text/plain'
  let example: unknown = request.body
  if (mode === 'json') {
    try { example = JSON.parse(request.body) } catch { /* Keep invalid JSON as the request's literal text. */ }
  } else if (mode === 'graphql') {
    let variables: unknown = {}
    try { variables = JSON.parse(request.bodyVariables || '{}') } catch { /* Keep the editor content intact. */ }
    example = { query: request.body, variables }
  }
  return { [mediaType]: { ...(mode === 'json' || mode === 'graphql' ? { schema: { type: 'object' } } : {}), example } }
}

function exportedAuth(request: SyncRequest, schemes: Record<string, unknown>): Record<string, unknown> | undefined {
  const auth = request.auth ?? { type: 'none' as const }
  if (auth.type === 'none') return undefined
  const keySuffix = auth.type === 'api-key' ? auth.name.replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) => next ? next.toUpperCase() : '') : ''
  const baseName = auth.type === 'bearer' ? 'BearerAuth' : auth.type === 'basic' ? 'BasicAuth' : `ApiKey${auth.location === 'header' ? 'Header' : 'Query'}${keySuffix}`
  const scheme = auth.type === 'bearer' ? { type: 'http', scheme: 'bearer' }
    : auth.type === 'basic' ? { type: 'http', scheme: 'basic' }
      : { type: 'apiKey', in: auth.location, name: auth.name || 'api_key' }
  let name = baseName || 'ApiKey'
  let suffix = 2
  while (schemes[name] && JSON.stringify(schemes[name]) !== JSON.stringify(scheme)) name = `${baseName}${suffix++}`
  schemes[name] = scheme
  return { [name]: [] }
}

function toOperationId(value: string, used: Set<string>): string {
  const base = value.trim().replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) => next ? next.toUpperCase() : '').replace(/^[^A-Za-z]+/, '') || 'request'
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}${suffix++}`
  used.add(candidate)
  return candidate
}

export function exportOpenApi(tree: SyncTreeNode[], title: string): OpenApiObject {
  const requests = flattenRequests(tree)
  const paths: Record<string, Record<string, unknown>> = {}
  const schemes: Record<string, unknown> = {}
  const operationIds = new Set<string>()
  const servers = new Set<string>()
  const operationServers = new Map<string, string>()
  const schemaRegistry = componentSchemaRegistry(requests.map(({ request }) => request))
  for (const { request } of requests) {
    const route = requestRoute(request.url)
    if (route.server) {
      servers.add(route.server)
      operationServers.set(request.id, route.server)
    }
  }
  const globalServer = servers.size === 1 ? [...servers][0] : undefined
  for (const { request, tags } of requests) {
    const route = requestRoute(request.url)
    const path = route.path.split('?')[0] || '/'
    const pathItem = paths[path] ?? (paths[path] = {})
    const method = request.method.toLowerCase()
    const operation: Record<string, unknown> = {
      operationId: toOperationId(request.name, operationIds),
      summary: request.name,
      responses: exportedResponses(request, schemaRegistry),
      'x-api-documentation-request-url': request.url
    }
    if (request.deprecated) operation.deprecated = true
    if (request.deprecationReason?.trim()) operation['x-api-documentation-deprecation-reason'] = request.deprecationReason
    if (tags.length) operation.tags = tags
    if (route.server && route.server !== globalServer) operation.servers = [{ url: route.server }]
    const parameters: Array<Record<string, unknown>> = []
    for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
      const pathParam = request.pathParams?.find((param) => param.name === match[1])
      parameters.push({ name: match[1], in: 'path', required: true, ...(pathParam?.description ? { description: pathParam.description } : {}), ...(pathParam?.value && !/token|key|secret|password|auth/i.test(pathParam.name) ? { example: pathParam.value } : {}), schema: { type: 'string' } })
    }
    for (const param of queryParams(request)) if (param.enabled && param.name.trim()) parameters.push({ name: param.name, in: 'query', required: false, ...(param.description ? { description: param.description } : {}), ...(/token|key|secret|password|auth/i.test(param.name) ? {} : { example: param.value }), schema: { type: 'string' } })
    for (const header of request.headers ?? []) {
      if (!header.enabled || !header.name.trim() || header.name.toLowerCase() === 'content-type') continue
      const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(header.name.trim())
      parameters.push({ name: header.name, in: 'header', required: false, ...(header.description ? { description: header.description } : {}), ...(!sensitive ? { example: header.value } : {}), schema: { type: 'string' } })
    }
    if (parameters.length) operation.parameters = parameters
    const content = bodyContent(request)
    if (content) operation.requestBody = { required: true, content }
    const security = exportedAuth(request, schemes)
    if (security) operation.security = [security]
    if (request.documentation?.trim()) operation.description = request.documentation
    pathItem[method] = operation
  }
  const spec: OpenApiObject = {
    openapi: '3.1.0',
    info: { title: title.trim() || 'API workspace', version: '1.0.0' },
    ...(globalServer ? { servers: [{ url: globalServer }] } : {}),
    paths
  }
  if (Object.keys(schemes).length || Object.keys(schemaRegistry.schemas).length) {
    spec.components = {
      ...(Object.keys(schemaRegistry.schemas).length ? { schemas: schemaRegistry.schemas } : {}),
      ...(Object.keys(schemes).length ? { securitySchemes: schemes } : {})
    }
  }
  return spec
}

export function serializeOpenApi(tree: SyncTreeNode[], title: string, format: 'json' | 'yaml'): string {
  const spec = exportOpenApi(tree, title)
  return format === 'yaml' ? stringify(spec) : JSON.stringify(spec, null, 2)
}
