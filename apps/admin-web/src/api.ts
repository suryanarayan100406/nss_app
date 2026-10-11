import type { Dashboard, Event, Photo, User } from './types';

const apiRoot = import.meta.env.VITE_API_ROOT || '/api/v1';
let csrf: string | null = null;

async function getCsrf() {
  const response = await fetch(`${apiRoot}/auth/csrf`, { credentials: 'include' });
  const body = await response.json() as { csrfToken?: string | null };
  csrf = body.csrfToken ?? null;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method ?? 'GET';
  if (method !== 'GET' && !csrf) await getCsrf();
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (method !== 'GET' && csrf) headers.set('X-CSRF-Token', csrf);
  const response = await fetch(`${apiRoot}${path}`, { ...options, headers, credentials: 'include' });
  const text = await response.text();
  const body = text ? JSON.parse(text) as T & { error?: { message?: string } } : undefined;
  if (!response.ok) {
    if (response.status === 403 && method !== 'GET') { csrf = null; await getCsrf(); }
    throw new Error(body?.error?.message || `Request failed (${response.status})`);
  }
  return body as T;
}

export const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
export const patchJson = (value: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(value) });
export const putJson = (value: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(value) });

export async function currentUser() { return (await api<{ user: User | null }>('/auth/me')).user; }
export async function login(email: string, password: string) { return (await api<{ user: User }>('/auth/login', json({ email, password }))).user; }
export async function logout() { await api('/auth/logout', { method: 'POST' }); }
export async function dashboard() { return api<Dashboard>('/admin/dashboard'); }
export async function events(params = '') { return api<{ items: Event[]; total: number }>(`/admin/events${params}`); }
export async function publicEvents(params = '') { return api<{ items: Event[]; total: number }>(`/public/events${params}`); }
export async function userPhotos() { return api<{ items: Photo[] }>('/me/photos'); }
export async function moderation(params = '') { return api<{ items: Photo[]; total: number }>(`/moderation/photos${params}`); }
