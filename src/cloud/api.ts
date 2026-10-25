const apiBaseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiCall<T>(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const result = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new ApiError(result.error || `Request failed (${response.status}).`, response.status)
  return result
}

export async function checkApiHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, { cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}
