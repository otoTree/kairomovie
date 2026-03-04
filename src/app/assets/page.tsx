"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { AppShell } from "@/components/app/app-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAuthSession } from "@/hooks/use-auth-session"
import { requestJson, toErrorMessage } from "@/lib/client-api"
import { saveAuth } from "@/lib/client-auth"
import { ensureDefaultProject } from "@/lib/client-project"

type Artifact = {
  id: string
  projectId: string
  taskId: string
  fileName: string
  objectKey: string
  relativePath: string
  kind: string | null
  size: number
  status: string
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  download: { url: string } | null
}

type ArtifactListResponse = {
  items: Artifact[]
  count: number
}

type CreateArtifactResponse = {
  upload: {
    url: string
    headers: Record<string, string>
  }
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export default function AssetsPage() {
  const router = useRouter()
  const { ready, token, user } = useAuthSession()
  const [projectId, setProjectId] = useState("")
  const [folder, setFolder] = useState("inbox")
  const [relativePath, setRelativePath] = useState("")
  const [uploadPrompt, setUploadPrompt] = useState("")
  const [uploadContent, setUploadContent] = useState("")
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<Artifact[]>([])
  const [filterFolder, setFilterFolder] = useState("")
  const [editingId, setEditingId] = useState("")
  const [editFolder, setEditFolder] = useState("")
  const [editPath, setEditPath] = useState("")
  const [editPrompt, setEditPrompt] = useState("")
  const [editContent, setEditContent] = useState("")
  const [message, setMessage] = useState("")

  const folders = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      set.add(item.taskId)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items])

  const filtered = useMemo(() => {
    if (!filterFolder) {
      return items
    }
    return items.filter((item) => item.taskId === filterFolder)
  }, [items, filterFolder])

  const loadAssets = useCallback(async (authToken: string, currentProjectId: string) => {
    setLoading(true)
    try {
      const result = await requestJson<ArtifactListResponse>(
        `/api/v1/storage/artifacts?projectId=${encodeURIComponent(currentProjectId)}&limit=300&withUrl=true`,
        { method: "GET" },
        authToken
      )
      setItems(result.items)
      if (!filterFolder && result.items.length > 0) {
        setFilterFolder(result.items[0].taskId)
      }
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [filterFolder])

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
        const project = await ensureDefaultProject(token)
        setProjectId(project.id)
        await loadAssets(token, project.id)
      } catch (error) {
        setMessage(toErrorMessage(error))
      }
    })()
  }, [ready, token, user, router, loadAssets])

  async function uploadFiles(files: FileList | null) {
    if (!token || !projectId) {
      return
    }
    if (!files || files.length === 0) {
      return
    }
    setUploading(true)
    setMessage("")
    try {
      for (const file of Array.from(files)) {
        const cleanPath = relativePath.trim().replace(/^\/+|\/+$/g, "")
        const filePath = cleanPath ? `${cleanPath}/${file.name}` : file.name
        const created = await requestJson<CreateArtifactResponse>(
          "/api/v1/storage/artifacts",
          {
            method: "POST",
            body: JSON.stringify({
              projectId,
              taskId: folder.trim() || "inbox",
              fileName: file.name,
              relativePath: filePath,
              kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file",
              mimeType: file.type || undefined,
              size: file.size,
              status: "uploaded",
              metadata: {
                prompt: uploadPrompt.trim() || null,
                content: uploadContent.trim() || null,
              },
            }),
          },
          token
        )
        await fetch(created.upload.url, {
          method: "PUT",
          headers: created.upload.headers,
          body: file,
        })
      }
      await loadAssets(token, projectId)
      setMessage("上传完成")
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setUploading(false)
    }
  }

  function startEdit(item: Artifact) {
    setEditingId(item.id)
    setEditFolder(item.taskId)
    setEditPath(item.relativePath || item.fileName)
    setEditPrompt(typeof item.metadata?.prompt === "string" ? item.metadata.prompt : "")
    setEditContent(typeof item.metadata?.content === "string" ? item.metadata.content : "")
  }

  async function saveEdit() {
    if (!token || !projectId || !editingId) {
      return
    }
    try {
      await requestJson(
        "/api/v1/storage/artifacts",
        {
          method: "PATCH",
          body: JSON.stringify({
            id: editingId,
            projectId,
            taskId: editFolder.trim() || "inbox",
            relativePath: editPath.trim(),
            metadata: {
              prompt: editPrompt.trim() || null,
              content: editContent.trim() || null,
            },
          }),
        },
        token
      )
      setEditingId("")
      await loadAssets(token, projectId)
      setMessage("已更新")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  async function deleteItem(id: string) {
    if (!token || !projectId) {
      return
    }
    try {
      await requestJson(
        `/api/v1/storage/artifacts?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
        token
      )
      await loadAssets(token, projectId)
      setMessage("已删除")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  if (!ready) {
    return null
  }

  return (
    <AppShell user={user} title="资产文件系统" subtitle="资产与项目解耦，默认写入系统项目，按文件夹管理并支持文件 CRUD。">
      <section className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="border-black/6">
          <CardHeader>
            <CardTitle>上传与元信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="文件夹，如 story-01" />
            <Input
              value={relativePath}
              onChange={(event) => setRelativePath(event.target.value)}
              placeholder="子路径，如 shots/closeup"
            />
            <Textarea
              value={uploadPrompt}
              onChange={(event) => setUploadPrompt(event.target.value)}
              rows={3}
              placeholder="prompt：生成该资产时使用的提示词"
            />
            <Textarea
              value={uploadContent}
              onChange={(event) => setUploadContent(event.target.value)}
              rows={4}
              placeholder="content：镜头、语义、风格等详细元信息"
            />
            <input
              type="file"
              multiple
              accept="image/*,video/*"
              disabled={uploading}
              onChange={(event) => void uploadFiles(event.target.files)}
              className="w-full cursor-pointer rounded-md border border-black/10 p-2 text-sm"
            />
            <p className="text-xs text-black/55">支持图片和视频上传，自动保存 prompt/content 元信息。</p>
            {message ? <p className="text-sm text-black/70">{message}</p> : null}
          </CardContent>
        </Card>

        <Card className="border-black/6">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>文件列表</CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant={!filterFolder ? "default" : "outline"} onClick={() => setFilterFolder("")}>
                全部
              </Button>
              {folders.map((name) => (
                <Button
                  key={name}
                  size="sm"
                  variant={filterFolder === name ? "default" : "outline"}
                  onClick={() => setFilterFolder(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? <p className="text-sm text-black/55">加载中...</p> : null}
            {filtered.map((item) => (
              <div key={item.id} className="rounded-xl border border-black/8 bg-[oklch(0.985_0_0)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{item.fileName}</p>
                  <Badge variant="outline">{item.kind || "file"}</Badge>
                </div>
                <p className="text-xs text-black/55">{item.taskId}/{item.relativePath}</p>
                <p className="mt-1 text-xs text-black/55">{formatSize(item.size)}</p>
                <p className="mt-2 text-xs text-black/70">
                  prompt：{typeof item.metadata?.prompt === "string" ? item.metadata.prompt : "无"}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-black/70">
                  content：{typeof item.metadata?.content === "string" ? item.metadata.content : "无"}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => startEdit(item)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void deleteItem(item.id)}>
                    删除
                  </Button>
                  {item.download?.url ? (
                    <a href={item.download.url} target="_blank" className="inline-flex">
                      <Button size="sm" variant="outline">
                        预览
                      </Button>
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
            {!loading && filtered.length === 0 ? <p className="text-sm text-black/55">暂无资产</p> : null}
          </CardContent>
        </Card>
      </section>

      {editingId ? (
        <section>
          <Card className="border-black/6">
            <CardHeader>
              <CardTitle>编辑文件</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <Input value={editFolder} onChange={(event) => setEditFolder(event.target.value)} placeholder="文件夹" />
              <Input value={editPath} onChange={(event) => setEditPath(event.target.value)} placeholder="相对路径" />
              <Textarea
                value={editPrompt}
                onChange={(event) => setEditPrompt(event.target.value)}
                rows={3}
                placeholder="prompt"
              />
              <Textarea
                value={editContent}
                onChange={(event) => setEditContent(event.target.value)}
                rows={3}
                placeholder="content"
              />
              <div className="flex gap-2 md:col-span-2">
                <Button onClick={saveEdit}>保存修改</Button>
                <Button variant="outline" onClick={() => setEditingId("")}>
                  取消
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </AppShell>
  )
}
