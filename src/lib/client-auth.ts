"use client"

export type AuthUser = {
  id: string
  email: string
}

export const TOKEN_KEY = "kairo_auth_token"
export const USER_KEY = "kairo_auth_user"

export function loadAuth() {
  if (typeof window === "undefined") {
    return { token: "", user: null as AuthUser | null }
  }
  const token = window.localStorage.getItem(TOKEN_KEY) || ""
  const rawUser = window.localStorage.getItem(USER_KEY)
  if (!rawUser) {
    return { token, user: null as AuthUser | null }
  }
  try {
    return {
      token,
      user: JSON.parse(rawUser) as AuthUser,
    }
  } catch {
    return { token, user: null as AuthUser | null }
  }
}

export function saveAuth(token: string, user: AuthUser) {
  window.localStorage.setItem(TOKEN_KEY, token)
  window.localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearAuth() {
  window.localStorage.removeItem(TOKEN_KEY)
  window.localStorage.removeItem(USER_KEY)
}
