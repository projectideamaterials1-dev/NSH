// src/api/http.ts
// Thin fetch wrapper: adds the X-API-Key header when the dashboard is built with VITE_API_KEY
// (only needed if the backend was started with API_KEY set).

const API_KEY: string | undefined = import.meta.env.VITE_API_KEY;

export const hasApiKey = (): boolean => Boolean(API_KEY);

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (API_KEY) headers.set('X-API-Key', API_KEY);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(path, { ...init, headers });
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}
