export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export async function request<T>(
  path: string,
  options: {
    method?: HttpMethod
    token?: string | null
    body?: unknown
    signal?: AbortSignal
  } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(payload?.detail ?? `Request failed with status ${response.status}`)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function requestBlob(path: string, token: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(payload?.detail ?? `Request failed with status ${response.status}`)
  }
  return response.blob()
}
