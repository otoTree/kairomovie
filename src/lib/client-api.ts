"use client"

export function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return "请求失败"
}

export async function requestJson<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers)
  if (!headers.has("content-type") && options.body) {
    headers.set("content-type", "application/json")
  }
  if (token) {
    headers.set("authorization", `Bearer ${token}`)
  }
  const response = await fetch(path, { ...options, headers })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.message || payload?.code || "请求失败"
    throw new Error(String(message))
  }
  return payload as T
}
