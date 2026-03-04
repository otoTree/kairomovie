"use client"

import { useMemo, useState } from "react"
import { AuthUser, clearAuth, loadAuth } from "@/lib/client-auth"

export function useAuthSession() {
  const initial = useMemo(() => loadAuth(), [])
  const [token, setToken] = useState(initial.token)
  const [user, setUser] = useState<AuthUser | null>(initial.user)

  function logout() {
    clearAuth()
    setToken("")
    setUser(null)
  }

  return {
    ready: true,
    token,
    user,
    setToken,
    setUser,
    logout,
  }
}
