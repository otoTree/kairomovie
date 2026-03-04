"use client"

import { useEffect, useState } from "react"
import { AuthUser, clearAuth, loadAuth } from "@/lib/client-auth"

export function useAuthSession() {
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState("")
  const [user, setUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    const initial = loadAuth()
    Promise.resolve().then(() => {
      setToken(initial.token)
      setUser(initial.user)
      setReady(true)
    })
  }, [])

  function logout() {
    clearAuth()
    setToken("")
    setUser(null)
  }

  return {
    ready,
    token,
    user,
    setToken,
    setUser,
    logout,
  }
}
