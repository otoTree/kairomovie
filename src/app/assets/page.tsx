"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { upload } from "@vercel/blob/client"
import {
  ArrowDownUp,
  CheckSquare,
  File,
  FileImage,
  FileVideo,
  Folder,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Square,
  Trash2,
  Upload,
} from "lucide-react"
import { AppShell } from "@/components/app/app-shell"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
  artifact: {
    id: string
    objectKey: string
  }
  upload: {
    url: string
    headers: Record<string, string>
  }
}

type ArtifactFolder = {
  id: string
  name: string
  source: string
  linkedCanvasName: string | null
  fileCount: number
  createdAt: string
  updatedAt: string
}

type FolderListResponse = {
  items: ArtifactFolder[]
  count: number
}

type PendingDelete =
  | { type: "file"; id: string; label: string }
  | { type: "batch"; ids: string[]; count: number }
  | { type: "folder"; name: string }

function formatSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function normalizeFolderName(raw: string) {
  const normalized = raw.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ")
  return normalized || "inbox"
}

function pathSegments(raw: string) {
  return raw
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
}

function fileBaseName(raw: string) {
  const parts = pathSegments(raw)
  return parts[parts.length - 1] || raw
}

export default function AssetsPage() {
  const router = useRouter()
  const { ready, token, user } = useAuthSession()
  const [projectId, setProjectId] = useState("")
  const [folder, setFolder] = useState("inbox")
  const [currentPath, setCurrentPath] = useState("")
  const [sortBy, setSortBy] = useState<"name" | "updatedAt" | "size">("updatedAt")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [relativePath, setRelativePath] = useState("")
  const [uploadPrompt, setUploadPrompt] = useState("")
  const [uploadContent, setUploadContent] = useState("")
  const [uploading, setUploading] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<Artifact[]>([])
  const [folders, setFolders] = useState<ArtifactFolder[]>([])
  const [filterFolder, setFilterFolder] = useState("")
  const [newFolderName, setNewFolderName] = useState("")
  const [renameFolderName, setRenameFolderName] = useState("")
  const [editingId, setEditingId] = useState("")
  const [editFolder, setEditFolder] = useState("")
  const [editPath, setEditPath] = useState("")
  const [editPrompt, setEditPrompt] = useState("")
  const [editContent, setEditContent] = useState("")
  const [message, setMessage] = useState("")
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)

  const mediaCount = useMemo(() => items.filter((item) => item.kind === "image" || item.kind === "video").length, [items])
  const fileCountByFolder = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of items) {
      map.set(item.taskId, (map.get(item.taskId) ?? 0) + 1)
    }
    return map
  }, [items])

  const filteredInFolder = useMemo(
    () => (filterFolder ? items.filter((item) => item.taskId === filterFolder) : items),
    [items, filterFolder]
  )

  const currentPathParts = useMemo(() => pathSegments(currentPath), [currentPath])

  const managerRows = useMemo(() => {
    if (!filterFolder) {
      return folders
        .map((entry) => ({
          key: `folder-${entry.name}`,
          kind: "folder" as const,
          name: entry.name,
          count: fileCountByFolder.get(entry.name) ?? entry.fileCount ?? 0,
          updatedAt: entry.updatedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    const dirMap = new Map<string, { name: string; count: number; updatedAt: string }>()
    const fileRows: Array<{ key: string; kind: "file"; file: Artifact; name: string }> = []

    for (const item of filteredInFolder) {
      const basePath = item.relativePath || item.fileName
      const parts = pathSegments(basePath)
      const parent = parts.slice(0, -1)
      const inCurrentDir =
        parent.length >= currentPathParts.length &&
        parent.slice(0, currentPathParts.length).join("/") === currentPathParts.join("/")
      if (!inCurrentDir) {
        continue
      }
      if (parent.length > currentPathParts.length) {
        const child = parent[currentPathParts.length]
        if (!child) {
          continue
        }
        const existed = dirMap.get(child)
        if (existed) {
          existed.count += 1
          if (new Date(item.updatedAt).getTime() > new Date(existed.updatedAt).getTime()) {
            existed.updatedAt = item.updatedAt
          }
        } else {
          dirMap.set(child, { name: child, count: 1, updatedAt: item.updatedAt })
        }
        continue
      }
      fileRows.push({
        key: item.id,
        kind: "file",
        file: item,
        name: fileBaseName(basePath),
      })
    }

    const sortedFiles = [...fileRows].sort((a, b) => {
      let compare = 0
      if (sortBy === "name") {
        compare = a.name.localeCompare(b.name)
      } else if (sortBy === "size") {
        compare = (a.file.size ?? 0) - (b.file.size ?? 0)
      } else {
        compare = new Date(a.file.updatedAt).getTime() - new Date(b.file.updatedAt).getTime()
      }
      return sortDirection === "asc" ? compare : -compare
    })

    const folderRows = [...dirMap.values()]
      .map((entry) => ({
        key: `child-${entry.name}`,
        kind: "folder" as const,
        name: entry.name,
        count: entry.count,
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return [...folderRows, ...sortedFiles]
  }, [currentPathParts, fileCountByFolder, filterFolder, filteredInFolder, folders, sortBy, sortDirection])

  const visibleFileIds = useMemo(
    () =>
      managerRows
        .filter((row): row is { key: string; kind: "file"; file: Artifact; name: string } => row.kind === "file")
        .map((row) => row.file.id),
    [managerRows]
  )
  const selectedVisibleCount = useMemo(
    () => visibleFileIds.filter((id) => selectedIds.includes(id)).length,
    [selectedIds, visibleFileIds]
  )
  const allVisibleSelected = visibleFileIds.length > 0 && selectedVisibleCount === visibleFileIds.length

  const loadAssets = useCallback(async (authToken: string, currentProjectId: string) => {
    const result = await requestJson<ArtifactListResponse>(
      `/api/v1/storage/artifacts?projectId=${encodeURIComponent(currentProjectId)}&limit=300&withUrl=true`,
      { method: "GET" },
      authToken
    )
    setItems(result.items)
  }, [])

  const loadFolders = useCallback(async (authToken: string, currentProjectId: string) => {
    const result = await requestJson<FolderListResponse>(
      `/api/v1/storage/folders?projectId=${encodeURIComponent(currentProjectId)}`,
      { method: "GET" },
      authToken
    )
    setFolders(result.items)
    if (!folder && result.items.length > 0) {
      setFolder(result.items[0].name)
    }
    if (filterFolder && !result.items.some((item) => item.name === filterFolder)) {
      setFilterFolder("")
    }
  }, [filterFolder, folder])

  const loadAll = useCallback(async (authToken: string, currentProjectId: string) => {
    setLoading(true)
    try {
      await Promise.all([loadAssets(authToken, currentProjectId), loadFolders(authToken, currentProjectId)])
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [loadAssets, loadFolders])

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
        await loadAll(token, project.id)
      } catch (error) {
        setMessage(toErrorMessage(error))
      }
    })()
  }, [ready, token, user, router, loadAll])

  useEffect(() => {
    setCurrentPath("")
    setSelectedIds([])
  }, [filterFolder])

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
      const folderName = normalizeFolderName(folder)
      for (const file of Array.from(files)) {
        const cleanPath = relativePath.trim().replace(/^\/+|\/+$/g, "")
        const filePath = cleanPath ? `${cleanPath}/${file.name}` : file.name
        const created = await requestJson<CreateArtifactResponse>(
          "/api/v1/storage/artifacts",
          {
            method: "POST",
            body: JSON.stringify({
              projectId,
              taskId: folderName,
              fileName: file.name,
              relativePath: filePath,
              kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file",
              mimeType: file.type || undefined,
              size: file.size,
              status: "pending",
              metadata: {
                prompt: uploadPrompt.trim() || null,
                content: uploadContent.trim() || null,
              },
              folderSource: "manual",
            }),
          },
          token
        )
        await upload(created.artifact.objectKey, file, {
          access: "public",
          handleUploadUrl: "/api/v1/storage/artifacts/upload",
          multipart: file.size > 5 * 1024 * 1024,
          contentType: file.type || undefined,
          headers: {
            authorization: `Bearer ${token}`,
          },
          clientPayload: JSON.stringify({
            projectId,
            artifactId: created.artifact.id,
          }),
        }).catch((error) => {
          const message = error instanceof Error ? error.message : "上传失败"
          throw new Error(`${message}：${file.name}`)
        })
        await requestJson(
          "/api/v1/storage/artifacts",
          {
            method: "PATCH",
            body: JSON.stringify({
              id: created.artifact.id,
              projectId,
              status: "uploaded",
            }),
          },
          token
        )
      }
      await loadAll(token, projectId)
      setFolder(folderName)
      setMessage("上传完成，文件已写入对象存储")
      setUploadDialogOpen(false)
    } catch (error) {
      if (token && projectId) {
        await loadAll(token, projectId).catch(() => undefined)
      }
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
      await loadAll(token, projectId)
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
      await loadAll(token, projectId)
      setMessage("已删除")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  async function deleteItems(ids: string[]) {
    if (!token || !projectId || ids.length === 0) {
      return
    }
    try {
      await Promise.all(
        ids.map((id) =>
          requestJson(
            `/api/v1/storage/artifacts?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`,
            { method: "DELETE" },
            token
          )
        )
      )
      setSelectedIds([])
      await loadAll(token, projectId)
      setMessage(`已批量删除 ${ids.length} 个文件`)
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  async function createFolder() {
    if (!token || !projectId) {
      return
    }
    if (!newFolderName.trim()) {
      setMessage("请输入文件夹名称")
      return
    }
    const name = normalizeFolderName(newFolderName)
    try {
      await requestJson(
        "/api/v1/storage/folders",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            name,
            source: "manual",
          }),
        },
        token
      )
      setNewFolderName("")
      setFolder(name)
      await loadFolders(token, projectId)
      setMessage("文件夹已创建")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  async function renameFolder() {
    if (!token || !projectId || !filterFolder) {
      return
    }
    if (!renameFolderName.trim()) {
      setMessage("请输入新的文件夹名称")
      return
    }
    const nextName = normalizeFolderName(renameFolderName)
    try {
      await requestJson(
        "/api/v1/storage/folders",
        {
          method: "PATCH",
          body: JSON.stringify({
            projectId,
            name: filterFolder,
            nextName,
          }),
        },
        token
      )
      setRenameFolderName("")
      setFilterFolder(nextName)
      if (folder === filterFolder) {
        setFolder(nextName)
      }
      await loadAll(token, projectId)
      setMessage("文件夹已重命名")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  async function deleteFolder(name: string) {
    if (!token || !projectId || !name) {
      return
    }
    try {
      await requestJson(
        `/api/v1/storage/folders?projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
        token
      )
      if (filterFolder === name) {
        setFilterFolder("")
      }
      if (folder === name) {
        setFolder("inbox")
      }
      await loadAll(token, projectId)
      setMessage("文件夹与其文件已删除")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  function toggleSelectAllCurrent() {
    setSelectedIds((prev) => {
      if (visibleFileIds.length === 0) {
        return []
      }
      const allSelected = visibleFileIds.every((id) => prev.includes(id))
      return allSelected ? prev.filter((id) => !visibleFileIds.includes(id)) : [...new Set([...prev, ...visibleFileIds])]
    })
  }

  async function confirmDelete() {
    if (!pendingDelete) {
      return
    }
    const action = pendingDelete
    setPendingDelete(null)
    if (action.type === "file") {
      await deleteItem(action.id)
      return
    }
    if (action.type === "batch") {
      await deleteItems(action.ids)
      return
    }
    await deleteFolder(action.name)
  }

  if (!ready) {
    return null
  }

  return (
    <AppShell user={user} title="资产文件系统" subtitle="资产与项目解耦，默认写入系统项目，按文件夹管理并支持文件 CRUD。">
      <section className="grid gap-5">
        <Card className="border-black/8 bg-[oklch(0.998_0_0)] shadow-[0_22px_60px_rgba(0,0,0,0.04)]">
          <CardHeader className="gap-3 border-b border-black/6 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <FolderKanban className="size-5" />
                文件管理器
              </CardTitle>
              <Button className="cursor-pointer" onClick={() => setUploadDialogOpen(true)}>
                <Upload />
                上传文件
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1 text-xs text-black/55">
              <button className="cursor-pointer rounded px-1.5 py-0.5 hover:bg-black/5" onClick={() => setFilterFolder("")}>
                此电脑
              </button>
              <span>/</span>
              <button className="cursor-pointer rounded px-1.5 py-0.5 hover:bg-black/5" onClick={() => setFilterFolder("")}>
                资产
              </button>
              <span>/</span>
              <button
                className="cursor-pointer rounded px-1.5 py-0.5 hover:bg-black/5"
                onClick={() => {
                  if (filterFolder) {
                    setCurrentPath("")
                  } else {
                    setFilterFolder("")
                  }
                }}
              >
                {filterFolder || "全部文件"}
              </button>
              {filterFolder &&
                currentPathParts.map((segment, index) => (
                  <div key={`${segment}-${index}`} className="flex items-center gap-1">
                    <span>/</span>
                    <button
                      className="cursor-pointer rounded px-1.5 py-0.5 hover:bg-black/5"
                      onClick={() => setCurrentPath(currentPathParts.slice(0, index + 1).join("/"))}
                    >
                      {segment}
                    </button>
                  </div>
                ))}
            </div>
          </CardHeader>
          <CardContent className="pt-5">
            <div className="grid gap-4 lg:grid-cols-[230px_1fr]">
              <div className="rounded-xl border border-black/8 bg-[oklch(0.99_0_0)] p-2">
                <button
                  className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    !filterFolder ? "bg-black text-white" : "hover:bg-black/5"
                  }`}
                  onClick={() => setFilterFolder("")}
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen className="size-4" />
                    全部文件
                  </span>
                  <span>{items.length}</span>
                </button>
                <div className="mt-2 space-y-1">
                  {folders.map((item) => {
                    const folderSelected = filterFolder === item.name
                    return (
                    <button
                      key={item.id}
                      className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                        folderSelected ? "bg-black text-white" : "hover:bg-black/5"
                      }`}
                      onClick={() => {
                        setFilterFolder(item.name)
                        setCurrentPath("")
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Folder className="size-4 shrink-0" />
                        <span className="truncate">{item.name}</span>
                      </span>
                      <span>{fileCountByFolder.get(item.name) ?? item.fileCount ?? 0}</span>
                    </button>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Input
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder="新建文件夹名称"
                      className="h-9 w-52 border-black/10 bg-white"
                    />
                    <Button size="sm" variant="outline" className="cursor-pointer" onClick={createFolder}>
                      <FolderPlus />
                      新建文件夹
                    </Button>
                    {filterFolder ? (
                      <>
                        <Input
                          value={renameFolderName}
                          onChange={(event) => setRenameFolderName(event.target.value)}
                          placeholder={`重命名 ${filterFolder}`}
                          className="h-9 w-52 border-black/10 bg-white"
                        />
                        <Button size="sm" variant="outline" className="cursor-pointer" onClick={renameFolder}>
                          重命名
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="cursor-pointer"
                          onClick={() => setPendingDelete({ type: "folder", name: filterFolder })}
                        >
                          删除文件夹
                        </Button>
                      </>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1.5">
                      <ArrowDownUp className="size-3.5 text-black/55" />
                      <select
                        value={sortBy}
                        onChange={(event) => setSortBy(event.target.value as "name" | "updatedAt" | "size")}
                        className="cursor-pointer bg-transparent text-xs"
                      >
                        <option value="name">按名称</option>
                        <option value="updatedAt">按时间</option>
                        <option value="size">按大小</option>
                      </select>
                      <select
                        value={sortDirection}
                        onChange={(event) => setSortDirection(event.target.value as "asc" | "desc")}
                        className="cursor-pointer bg-transparent text-xs"
                      >
                        <option value="asc">升序</option>
                        <option value="desc">降序</option>
                      </select>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="cursor-pointer"
                      disabled={selectedIds.length === 0}
                      onClick={() =>
                        setPendingDelete({
                          type: "batch",
                          ids: [...selectedIds],
                          count: selectedIds.length,
                        })
                      }
                    >
                      <Trash2 />
                      批量删除({selectedIds.length})
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="rounded-xl border border-black/6 bg-[oklch(0.985_0_0)] px-3 py-2">
                    <p className="text-[11px] text-black/50">当前展示</p>
                    <p className="mt-1 text-sm font-medium">{visibleFileIds.length} 个文件</p>
                  </div>
                  <div className="rounded-xl border border-black/6 bg-[oklch(0.985_0_0)] px-3 py-2">
                    <p className="text-[11px] text-black/50">子目录</p>
                    <p className="mt-1 flex items-center gap-1 text-sm font-medium">
                      <Folder className="size-3.5" />
                      {managerRows.filter((row) => row.kind === "folder").length}
                    </p>
                  </div>
                  <div className="rounded-xl border border-black/6 bg-[oklch(0.985_0_0)] px-3 py-2">
                    <p className="text-[11px] text-black/50">已选择</p>
                    <p className="mt-1 flex items-center gap-1 text-sm font-medium">
                      {allVisibleSelected ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
                      {selectedVisibleCount}
                    </p>
                  </div>
                  <div className="rounded-xl border border-black/6 bg-[oklch(0.985_0_0)] px-3 py-2">
                    <p className="text-[11px] text-black/50">当前文件夹</p>
                    <p className="mt-1 truncate text-sm font-medium">{filterFolder || "全部"}</p>
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-black/8">
                  <div className="grid grid-cols-[46px_1.7fr_1fr_120px_120px_220px] border-b border-black/8 bg-[oklch(0.988_0_0)] px-3 py-2 text-xs text-black/55">
                    <button className="flex cursor-pointer items-center justify-center" onClick={toggleSelectAllCurrent}>
                      {allVisibleSelected ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
                    </button>
                    <span>名称</span>
                    <span>目录</span>
                    <span>大小</span>
                    <span>状态</span>
                    <span>操作</span>
                  </div>
                  {loading ? <p className="px-3 py-4 text-sm text-black/55">加载中...</p> : null}
                  {!loading &&
                    managerRows.map((row) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-[46px_1.7fr_1fr_120px_120px_220px] items-center border-b border-black/6 px-3 py-2 text-sm last:border-b-0 hover:bg-[oklch(0.992_0_0)]"
                    >
                      <div className="flex items-center justify-center">
                        {row.kind === "file" ? (
                          <button className="cursor-pointer" onClick={() => toggleSelect(row.file.id)}>
                            {selectedIds.includes(row.file.id) ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
                          </button>
                        ) : (
                          <span className="text-black/25">—</span>
                        )}
                      </div>
                      {row.kind === "folder" ? (
                        <>
                          <button
                            className="flex cursor-pointer items-center gap-2 truncate text-left font-medium text-black/90"
                            onClick={() => {
                              if (!filterFolder) {
                                setFilterFolder(row.name)
                                setCurrentPath("")
                              } else {
                                const next = [...currentPathParts, row.name].join("/")
                                setCurrentPath(next)
                              }
                            }}
                          >
                            <Folder className="size-4 shrink-0" />
                            <span className="truncate">{row.name}</span>
                          </button>
                          <p className="truncate text-black/70">{filterFolder || "根目录"}</p>
                          <p className="text-black/70">—</p>
                          <p className="text-xs text-black/70">{row.count} 项</p>
                          <div className="text-xs text-black/45">双击进入</div>
                        </>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-black/90">{row.name}</p>
                            <p className="mt-0.5 truncate text-xs text-black/55">{row.file.relativePath}</p>
                          </div>
                          <p className="truncate text-black/70">{row.file.taskId}</p>
                          <p className="text-black/70">{formatSize(row.file.size)}</p>
                          <div className="flex items-center gap-1">
                            {row.file.kind === "image" ? <FileImage className="size-3.5 text-black/60" /> : null}
                            {row.file.kind === "video" ? <FileVideo className="size-3.5 text-black/60" /> : null}
                            {!row.file.kind || row.file.kind === "file" ? <File className="size-3.5 text-black/60" /> : null}
                            <span className="text-xs text-black/70">{row.file.status}</span>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => startEdit(row.file)}>
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="cursor-pointer"
                              onClick={() => setPendingDelete({ type: "file", id: row.file.id, label: row.file.fileName })}
                            >
                              删除
                            </Button>
                            {row.file.download?.url ? (
                              <a href={row.file.download.url} target="_blank" className="inline-flex">
                                <Button size="sm" variant="outline" className="cursor-pointer">
                                  预览
                                </Button>
                              </a>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  {!loading && managerRows.length === 0 ? (
                    <div className="px-6 py-12 text-center">
                      <p className="text-sm text-black/55">该目录为空，上传文件后会出现在这里。</p>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="max-w-2xl border-black/10 bg-white">
          <DialogHeader>
            <DialogTitle className="text-black">上传与元信息</DialogTitle>
            <DialogDescription>上传图片或视频，并可写入 prompt/content 元信息。</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-black/8 bg-[oklch(0.992_0_0)] p-3">
              <p className="text-[11px] text-black/50">总文件</p>
              <p className="mt-1 text-base font-semibold">{items.length}</p>
            </div>
            <div className="rounded-xl border border-black/8 bg-[oklch(0.992_0_0)] p-3">
              <p className="text-[11px] text-black/50">媒体</p>
              <p className="mt-1 text-base font-semibold">{mediaCount}</p>
            </div>
            <div className="rounded-xl border border-black/8 bg-[oklch(0.992_0_0)] p-3">
              <p className="text-[11px] text-black/50">分组</p>
              <p className="mt-1 text-base font-semibold">{folders.length || 0}</p>
            </div>
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-black/8 bg-[oklch(0.992_0_0)] p-3">
              <p className="mb-2 text-xs text-black/55">上传目录</p>
              <select
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                className="h-9 w-full rounded-md border border-black/10 bg-white px-3 text-sm"
              >
                {folders.length === 0 ? <option value="inbox">inbox</option> : null}
                {folders.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <Input
              value={relativePath}
              onChange={(event) => setRelativePath(event.target.value)}
              placeholder="子路径，如 shots/closeup"
              className="border-black/10 bg-white"
            />
            <Textarea
              value={uploadPrompt}
              onChange={(event) => setUploadPrompt(event.target.value)}
              rows={3}
              placeholder="prompt：生成该资产时使用的提示词"
              className="border-black/10 bg-white"
            />
            <Textarea
              value={uploadContent}
              onChange={(event) => setUploadContent(event.target.value)}
              rows={4}
              placeholder="content：镜头、语义、风格等详细元信息"
              className="border-black/10 bg-white"
            />
            <input
              id="asset-upload-input"
              type="file"
              multiple
              accept="image/*,video/*"
              disabled={uploading}
              onChange={(event) => void uploadFiles(event.target.files)}
              className="hidden"
            />
            <label
              htmlFor="asset-upload-input"
              className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-black/10 bg-white px-4 py-3 text-sm font-medium transition hover:bg-[oklch(0.985_0_0)]"
            >
              <Upload className="size-4" />
              {uploading ? "上传中..." : "选择文件并上传"}
            </label>
            {message ? (
              <p className="rounded-lg border border-black/8 bg-[oklch(0.99_0_0)] px-3 py-2 text-sm text-black/75">{message}</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingId)} onOpenChange={(open) => !open && setEditingId("")}>
        <DialogContent className="max-w-2xl border-black/10 bg-white">
          <DialogHeader>
            <DialogTitle className="text-black">编辑文件</DialogTitle>
            <DialogDescription>修改文件目录、路径与元信息。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              value={editFolder}
              onChange={(event) => setEditFolder(event.target.value)}
              placeholder="文件夹"
              className="border-black/10 bg-white"
            />
            <Input
              value={editPath}
              onChange={(event) => setEditPath(event.target.value)}
              placeholder="相对路径"
              className="border-black/10 bg-white"
            />
            <Textarea
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              rows={3}
              placeholder="prompt"
              className="border-black/10 bg-white"
            />
            <Textarea
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              rows={3}
              placeholder="content"
              className="border-black/10 bg-white"
            />
            <div className="flex gap-2 md:col-span-2">
              <Button className="cursor-pointer" onClick={saveEdit}>
                保存修改
              </Button>
              <Button variant="outline" className="cursor-pointer" onClick={() => setEditingId("")}>
                取消
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.type === "file" ? `将删除文件「${pendingDelete.label}」，此操作不可恢复。` : null}
              {pendingDelete?.type === "batch" ? `将删除选中的 ${pendingDelete.count} 个文件，此操作不可恢复。` : null}
              {pendingDelete?.type === "folder" ? `将删除文件夹「${pendingDelete.name}」及其全部文件，此操作不可恢复。` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  )
}
