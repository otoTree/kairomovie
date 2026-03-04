"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AppShell } from "@/components/app/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAuthSession } from "@/hooks/use-auth-session"
import { requestJson, toErrorMessage } from "@/lib/client-api"
import { saveAuth } from "@/lib/client-auth"
import { ensureDefaultProject } from "@/lib/client-project"

type Project = {
  id: string
  name: string
  description: string | null
  settings: Record<string, unknown>
}

type ProviderConfigItem = {
  provider: string
  config: unknown
}

export default function SettingsPage() {
  const router = useRouter()
  const { ready, token, user, logout } = useAuthSession()
  const [projectId, setProjectId] = useState("")
  const [projectName, setProjectName] = useState("未命名项目")
  const [modelName, setModelName] = useState("toapis/default")
  const [toolsEnabled, setToolsEnabled] = useState(true)
  const [storageStrategy, setStorageStrategy] = useState("project")
  const [providerName, setProviderName] = useState("toapis")
  const [providerConfigText, setProviderConfigText] = useState("{\n  \"model\": \"gpt-4.1\"\n}")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!ready) {
      return
    }
    if (!token || !user) {
      router.replace("/login")
      return
    }
    saveAuth(token, user)
    void (async () => {
      try {
        const current = await ensureDefaultProject(token)
        setProjectId(current.id)
        setProjectName(current.name)
        await loadSettings(token, current.id)
      } catch (error) {
        setMessage(toErrorMessage(error))
      }
    })()
  }, [ready, token, user, router])

  async function loadSettings(authToken: string, currentProjectId: string) {
    const detail = await requestJson<Project>(`/api/v1/projects/${currentProjectId}`, { method: "GET" }, authToken)
    const projectSettings = detail.settings || {}
    setModelName(typeof projectSettings.modelName === "string" ? projectSettings.modelName : "toapis/default")
    setToolsEnabled(projectSettings.toolsEnabled !== false)
    setStorageStrategy(typeof projectSettings.storageStrategy === "string" ? projectSettings.storageStrategy : "project")

    const provider = await requestJson<{ items: ProviderConfigItem[] }>(
      `/api/v1/projects/${currentProjectId}/provider-config`,
      { method: "GET" },
      authToken
    )
    const config = provider.items.find((item) => item.provider === "toapis") || provider.items[0]
    if (config) {
      setProviderName(config.provider)
      setProviderConfigText(JSON.stringify(config.config || {}, null, 2))
    }
  }

  async function saveProjectSettings() {
    if (!token || !projectId) {
      return
    }
    setSaving(true)
    setMessage("")
    try {
      let configValue: unknown = {}
      try {
        configValue = JSON.parse(providerConfigText || "{}")
      } catch {
        throw new Error("Provider 配置不是合法 JSON")
      }

      await requestJson(
        `/api/v1/projects/${projectId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: projectName.trim() || "未命名项目",
            settings: {
              modelName,
              toolsEnabled,
              storageStrategy,
            },
          }),
        },
        token
      )
      await requestJson(
        `/api/v1/projects/${projectId}/provider-config`,
        {
          method: "PUT",
          body: JSON.stringify({
            provider: providerName.trim() || "toapis",
            config: configValue,
          }),
        },
        token
      )
      setMessage("设置保存成功")
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  if (!ready) {
    return null
  }

  return (
    <AppShell user={user} title="设置中心" subtitle="把复杂操作收敛到这里，工作台保持最少点击路径。">
      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="border-black/6">
          <CardHeader>
            <CardTitle>默认项目</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="项目名" />
            <p className="text-sm text-black/60">系统会自动创建未命名项目，工作台和资产默认都使用它。</p>
          </CardContent>
        </Card>

        <Card className="border-black/6">
          <CardHeader>
            <CardTitle>运行配置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="模型名" />
            <div className="flex items-center justify-between rounded-md border border-black/10 px-3 py-2">
              <span className="text-sm">启用工具链</span>
              <input
                type="checkbox"
                checked={toolsEnabled}
                onChange={(event) => setToolsEnabled(event.target.checked)}
                className="cursor-pointer"
              />
            </div>
            <select
              className="h-9 w-full rounded-md border border-black/10 bg-white px-3 text-sm"
              value={storageStrategy}
              onChange={(event) => setStorageStrategy(event.target.value)}
            >
              <option value="project">project</option>
              <option value="user">user</option>
              <option value="archive">archive</option>
            </select>
            <Input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="provider" />
            <Textarea
              value={providerConfigText}
              onChange={(event) => setProviderConfigText(event.target.value)}
              rows={8}
              placeholder="Provider JSON 配置"
            />
            <Button disabled={saving || !projectId} className="w-full cursor-pointer" onClick={saveProjectSettings}>
              {saving ? "保存中..." : "保存设置"}
            </Button>
            {message ? <p className="text-sm text-black/65">{message}</p> : null}
            <Button variant="outline" className="w-full cursor-pointer" onClick={logout}>
              退出登录
            </Button>
          </CardContent>
        </Card>
      </section>
    </AppShell>
  )
}
