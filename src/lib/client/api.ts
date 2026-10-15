"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: { error?: { message?: string; code?: string } & Record<string, unknown> } = {};
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const e = body.error ?? {};
  return new ApiError(res.status, e.message ?? `Request failed (${res.status})`, e.code ?? "error", e);
}

export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
