"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AppShell } from "@/components/app/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { requestJson, toErrorMessage } from "@/lib/client-api"
import { AuthUser, loadAuth, saveAuth } from "@/lib/client-auth"

type AuthResponse = {
  token: string
  user: AuthUser
}

export default function LoginPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [authMode, setAuthMode] = useState<"login" | "register">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    const saved = loadAuth()
    if (saved.token) {
      router.replace("/workspace")
      return
    }
    setReady(true)
  }, [router])

  async function handleSubmit() {
    if (!email.trim() || !password.trim()) {
      setMessage("请输入邮箱和密码")
      return
    }
    setLoading(true)
    setMessage("")
    try {
      const endpoint = authMode === "login" ? "/api/v1/auth/login" : "/api/v1/auth/register"
      const result = await requestJson<AuthResponse>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      })
      saveAuth(result.token, result.user)
      router.replace("/workspace")
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  if (!ready) {
    return null
  }

  return (
    <AppShell user={null} title="欢迎使用 Kairo" subtitle="请先登录，再进入设置、资产与工作台。">
      <section className="mx-auto w-full max-w-md">
        <Card className="border-black/6">
          <CardHeader>
            <CardTitle>{authMode === "login" ? "登录账号" : "注册账号"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="邮箱"
              type="email"
            />
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码（至少 8 位）"
              type="password"
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={authMode === "login" ? "default" : "outline"}
                onClick={() => setAuthMode("login")}
                className="cursor-pointer"
              >
                登录
              </Button>
              <Button
                variant={authMode === "register" ? "default" : "outline"}
                onClick={() => setAuthMode("register")}
                className="cursor-pointer"
              >
                注册
              </Button>
            </div>
            <Button className="w-full cursor-pointer" disabled={loading} onClick={handleSubmit}>
              {loading ? "提交中..." : authMode === "login" ? "进入工作台" : "注册并进入"}
            </Button>
            {message ? <p className="text-sm text-black/65">{message}</p> : null}
          </CardContent>
        </Card>
      </section>
    </AppShell>
  )
}
