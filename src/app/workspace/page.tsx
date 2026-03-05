"use client"

import Image from "next/image"
import Link from "next/link"
import {
  FolderOpen,
  History,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Save,
  SendHorizontal,
  Settings,
  Type,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { upload } from "@vercel/blob/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAuthSession } from "@/hooks/use-auth-session"
import { requestJson, toErrorMessage } from "@/lib/client-api"
import { saveAuth } from "@/lib/client-auth"
import { ensureDefaultProject } from "@/lib/client-project"

type Asset = {
  id: string
  fileName: string
  taskId: string
  kind: string | null
  metadata: Record<string, unknown>
  download: { url: string } | null
}

type CanvasNode = {
  id: string
  type: "text" | "image" | "video"
  x: number
  y: number
  width: number
  height: number
  text?: string
  src?: string
  title: string
  content?: string
}

type ChatResponse = {
  mode: "event" | "sync"
  correlationId: string
  events?: Array<{
    id: string
    type: string
    data: Record<string, unknown>
    time?: string
  }>
}

type ChatHistoryResponse = {
  sessionId: string
  items: Array<{
    role: "user" | "assistant" | "thought" | "event"
    text: string
    createdAt?: string
  }>
  count: number
}

type SessionSummary = {
  sessionId: string
  lastAt: string
  messageCount: number
  lastMessage: string
}

type EventItem = {
  id: string
  type: string
  data: Record<string, unknown>
  createdAt?: string
}

type Message = {
  role: "user" | "assistant" | "thought" | "event"
  text: string
  createdAt?: string
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

type CanvasSnapshot = {
  nodes: CanvasNode[]
  messages: Message[]
  chatSessions?: SessionSummary[]
  scale: number
  offset: { x: number; y: number }
  canvasName: string
}

type CanvasHistoryItem = {
  id: string
  name: string
  sessionId: string
  snapshot?: CanvasSnapshot
  createdAt: string
  updatedAt: string
}

type CanvasHistoryListResponse = {
  items: CanvasHistoryItem[]
  count: number
}

type CanvasItem = {
  id: string
  name: string
  sessionId: string
  snapshot?: CanvasSnapshot
  createdAt: string
  updatedAt: string
}

type CanvasListResponse = {
  items: CanvasItem[]
  count: number
}

function toText(value: unknown) {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value)
  }
  return ""
}

function extractMessagesFromEvents(items: EventItem[]): Message[] {
  const ordered = [...items].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return ta - tb
  })
  const lines: Message[] = []
  for (const event of ordered) {
    const data = event.data || {}
    if (event.type === "kairo.agent.thought") {
      const thought = toText(data.thought)
      if (thought) {
        lines.push({ role: "thought", text: thought, createdAt: event.createdAt })
      }
      continue
    }
    if (event.type === "kairo.agent.action") {
      const action = data.action
      if (typeof action === "object" && action !== null) {
        const actionRecord = action as Record<string, unknown>
        const actionType = toText(actionRecord.type)
        const content = toText(actionRecord.content)
        if ((actionType === "say" || actionType === "query") && content) {
          lines.push({ role: "assistant", text: content, createdAt: event.createdAt })
        } else if (actionType) {
          lines.push({ role: "event", text: `动作: ${actionType}`, createdAt: event.createdAt })
        }
      }
      continue
    }
    if (event.type === "kairo.tool.result") {
      const error = toText(data.error)
      const result = toText(data.result)
      if (error) {
        lines.push({ role: "event", text: `工具错误: ${error}`, createdAt: event.createdAt })
      } else if (result) {
        lines.push({ role: "event", text: `工具结果: ${result}`, createdAt: event.createdAt })
      }
      continue
    }
    if (event.type === "kairo.intent.started") {
      const intent = toText(data.intent)
      if (intent) {
        lines.push({ role: "event", text: `开始处理: ${intent}`, createdAt: event.createdAt })
      }
      continue
    }
    if (event.type === "kairo.intent.ended") {
      const error = toText(data.error)
      const result = toText(data.result)
      if (error) {
        lines.push({ role: "event", text: `处理失败: ${error}`, createdAt: event.createdAt })
      } else if (result) {
        lines.push({ role: "event", text: `处理完成: ${result}`, createdAt: event.createdAt })
      } else {
        lines.push({ role: "event", text: "处理完成", createdAt: event.createdAt })
      }
      continue
    }
  }
  return lines
}

type Guides = {
  x: number | null
  y: number | null
}

type DragStartState = {
  x: number
  y: number
  nodeX: number
  nodeY: number
  width: number
  height: number
}

type PanStartState = {
  x: number
  y: number
  offsetX: number
  offsetY: number
}

const BOARD_SIZE = 12000
const SESSION_STORAGE_KEY = "kairo.workspace.sessionId"

function randomId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createCanvasName() {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  return `未命名画布 ${date}`
}

function createSessionId() {
  return `canvas-${Date.now()}`
}

function createChatSessionId(canvas: string) {
  const safe = canvas
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
  return `${safe || "canvas"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createVersionName(canvas: string) {
  const now = new Date()
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
  return `${toFolderName(canvas)} · ${time}`
}

function toFolderName(raw: string) {
  const normalized = raw.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ")
  return normalized || "未命名画布"
}

function getInitialSessionId() {
  if (typeof window === "undefined") {
    return createSessionId()
  }
  const saved = window.localStorage.getItem(SESSION_STORAGE_KEY)?.trim()
  if (saved) {
    return saved
  }
  const next = createSessionId()
  window.localStorage.setItem(SESSION_STORAGE_KEY, next)
  return next
}

export default function WorkspacePage() {
  const router = useRouter()
  const { ready, token, user } = useAuthSession()
  const [assets, setAssets] = useState<Asset[]>([])
  const [projectId, setProjectId] = useState("")
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [draggingId, setDraggingId] = useState("")
  const [guides, setGuides] = useState<Guides>({ x: null, y: null })
  const [isPanning, setIsPanning] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [sessionId, setSessionId] = useState(getInitialSessionId)
  const [message, setMessage] = useState("")
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: BOARD_SIZE / 2 - 700, y: BOARD_SIZE / 2 - 420 })
  const [canvasName, setCanvasName] = useState(createCanvasName())
  const [isSidebarHover, setIsSidebarHover] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [historyItems, setHistoryItems] = useState<CanvasHistoryItem[]>([])
  const [historySaving, setHistorySaving] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [activeHistoryId, setActiveHistoryId] = useState("")
  const [canvasItems, setCanvasItems] = useState<CanvasItem[]>([])
  const [canvasLoading, setCanvasLoading] = useState(false)
  const [canvasSaving, setCanvasSaving] = useState(false)
  const [activeCanvasId, setActiveCanvasId] = useState("")
  const [chatSessions, setChatSessions] = useState<SessionSummary[]>([])
  const [sessionListLoading, setSessionListLoading] = useState(false)
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<DragStartState | null>(null)
  const panStartRef = useRef<PanStartState | null>(null)
  const activeCanvasIdRef = useRef("")
  const activeHistoryIdRef = useRef("")

  const mediaAssets = useMemo(() => assets.filter((item) => item.kind === "image" || item.kind === "video"), [assets])

  const loadAssets = useCallback(async (authToken: string, nextProjectId: string) => {
    try {
      const result = await requestJson<{ items: Asset[] }>(
        `/api/v1/storage/artifacts?projectId=${encodeURIComponent(nextProjectId)}&limit=240&withUrl=true`,
        { method: "GET" },
        authToken
      )
      setAssets(result.items)
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }, [])

  const loadCanvasHistories = useCallback(async (authToken: string, nextProjectId: string) => {
    setHistoryLoading(true)
    try {
      const result = await requestJson<CanvasHistoryListResponse>(
        `/api/v1/workspace/histories?projectId=${encodeURIComponent(nextProjectId)}&withSnapshot=true`,
        { method: "GET" },
        authToken
      )
      setHistoryItems(result.items)
      if (result.items.length === 0) {
        setActiveHistoryId("")
      } else if (!result.items.some((item) => item.id === activeHistoryIdRef.current)) {
        setActiveHistoryId("")
      }
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const loadChatSessions = useCallback(
    async (authToken: string, nextProjectId: string, nextCanvasName: string) => {
      setSessionListLoading(true)
      try {
        const result = await requestJson<{ items: SessionSummary[]; count: number }>(
          `/api/v1/agent/sessions?projectId=${encodeURIComponent(nextProjectId)}&canvasName=${encodeURIComponent(nextCanvasName)}&limit=30`,
          { method: "GET" },
          authToken
        )
        setChatSessions(result.items)
      } catch (error) {
        setMessage(toErrorMessage(error))
      } finally {
        setSessionListLoading(false)
      }
    },
    []
  )

  const loadChatHistory = useCallback(
    async (authToken: string, nextProjectId: string, nextSessionId: string) => {
      if (!nextSessionId) {
        setMessages([])
        return
      }
      setChatHistoryLoading(true)
      try {
        const result = await requestJson<ChatHistoryResponse>(
          `/api/v1/agent/chat?projectId=${encodeURIComponent(nextProjectId)}&sessionId=${encodeURIComponent(nextSessionId)}&limit=180`,
          { method: "GET" },
          authToken
        )
        setMessages(
          result.items.map((item) => ({
            role: item.role,
            text: item.text,
            createdAt: item.createdAt,
          }))
        )
      } catch (error) {
        setMessage(toErrorMessage(error))
      } finally {
        setChatHistoryLoading(false)
      }
    },
    []
  )

  const applyCanvasSnapshot = useCallback(
    async (authToken: string, nextProjectId: string, canvas: CanvasItem) => {
      if (!canvas.snapshot) {
        return
      }
      setActiveCanvasId(canvas.id)
      setNodes(canvas.snapshot.nodes)
      setMessages(canvas.snapshot.messages)
      setChatSessions(canvas.snapshot.chatSessions || [])
      setScale(canvas.snapshot.scale)
      setOffset(canvas.snapshot.offset)
      setCanvasName(canvas.snapshot.canvasName || canvas.name)
      const nextSessionId = canvas.sessionId || createChatSessionId(canvas.snapshot.canvasName || canvas.name)
      setSessionId(nextSessionId)
      await Promise.all([
        loadChatSessions(authToken, nextProjectId, canvas.snapshot.canvasName || canvas.name),
        loadChatHistory(authToken, nextProjectId, nextSessionId),
      ])
    },
    [loadChatHistory, loadChatSessions]
  )

  const loadCanvases = useCallback(
    async (authToken: string, nextProjectId: string, preferredCanvasId?: string) => {
      setCanvasLoading(true)
      try {
        const result = await requestJson<CanvasListResponse>(
          `/api/v1/workspace/canvases?projectId=${encodeURIComponent(nextProjectId)}&withSnapshot=true`,
          { method: "GET" },
          authToken
        )
        setCanvasItems(result.items)
        if (result.items.length === 0) {
          setActiveCanvasId("")
          return
        }
        const targetCanvasId = preferredCanvasId || activeCanvasIdRef.current
        const current = result.items.find((item) => item.id === targetCanvasId) || result.items[0]
        await applyCanvasSnapshot(authToken, nextProjectId, current)
      } catch (error) {
        setMessage(toErrorMessage(error))
      } finally {
        setCanvasLoading(false)
      }
    },
    [applyCanvasSnapshot]
  )

  useEffect(() => {
    activeCanvasIdRef.current = activeCanvasId
  }, [activeCanvasId])

  useEffect(() => {
    activeHistoryIdRef.current = activeHistoryId
  }, [activeHistoryId])

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
        await Promise.all([
          loadAssets(token, project.id),
          loadCanvases(token, project.id),
          loadCanvasHistories(token, project.id),
        ])
      } catch (error) {
        setMessage(toErrorMessage(error))
      }
    })()
  }, [ready, token, user, router, loadAssets, loadCanvases, loadCanvasHistories])

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  }, [sessionId])

  useEffect(() => {
    if (!token || !projectId) {
      return
    }
    void loadChatSessions(token, projectId, canvasName)
  }, [token, projectId, canvasName, loadChatSessions])

  function resetCanvas() {
    const nextCanvasName = createCanvasName()
    setNodes([])
    setMessages([])
    const nextSessionId = createChatSessionId(nextCanvasName)
    setSessionId(nextSessionId)
    setChatSessions([])
    setActiveCanvasId("")
    setScale(1)
    setOffset({ x: BOARD_SIZE / 2 - 700, y: BOARD_SIZE / 2 - 420 })
    setCanvasName(nextCanvasName)
    setActiveHistoryId("")
    setMessage("已新建画布")
  }

  function addTextNode(x?: number, y?: number) {
    const node: CanvasNode = {
      id: randomId(),
      type: "text",
      x: x ?? offset.x + 320,
      y: y ?? offset.y + 240,
      width: 340,
      height: 180,
      text: "双击我编辑文本内容",
      title: "文本卡片",
      content: "你可以在这里写分镜、旁白或镜头提示词。",
    }
    setNodes((prev) => [...prev, node])
  }

  function toWorldPoint(clientX: number, clientY: number) {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) {
      return { x: offset.x, y: offset.y }
    }
    return {
      x: (clientX - rect.left) / scale + offset.x,
      y: (clientY - rect.top) / scale + offset.y,
    }
  }

  function createMediaNode(asset: Asset, worldX: number, worldY: number) {
    if (!asset.download?.url) {
      return
    }
    const isVideo = asset.kind === "video"
    const width = isVideo ? 440 : 380
    const height = isVideo ? 290 : 260
    const node: CanvasNode = {
      id: randomId(),
      type: isVideo ? "video" : "image",
      x: worldX - width / 2,
      y: worldY - height / 2,
      width,
      height,
      src: asset.download.url,
      title: asset.fileName,
      content: typeof asset.metadata?.content === "string" ? asset.metadata.content : "",
    }
    setNodes((prev) => [...prev, node])
  }

  function addMediaNode(asset: Asset) {
    const worldX = offset.x + 420
    const worldY = offset.y + 300
    createMediaNode(asset, worldX, worldY)
  }

  function computeSnap(
    movingId: string,
    proposedX: number,
    proposedY: number,
    width: number,
    height: number
  ): { x: number; y: number; guides: Guides } {
    const threshold = 10 / scale
    let snappedX = proposedX
    let snappedY = proposedY
    let guideX: number | null = null
    let guideY: number | null = null
    let bestX = Infinity
    let bestY = Infinity

    const xAnchors = [
      { value: proposedX, offset: 0 },
      { value: proposedX + width / 2, offset: width / 2 },
      { value: proposedX + width, offset: width },
    ]
    const yAnchors = [
      { value: proposedY, offset: 0 },
      { value: proposedY + height / 2, offset: height / 2 },
      { value: proposedY + height, offset: height },
    ]

    for (const node of nodes) {
      if (node.id === movingId) {
        continue
      }
      const candidateX = [node.x, node.x + node.width / 2, node.x + node.width]
      const candidateY = [node.y, node.y + node.height / 2, node.y + node.height]

      for (const anchor of xAnchors) {
        for (const value of candidateX) {
          const distance = Math.abs(anchor.value - value)
          if (distance <= threshold && distance < bestX) {
            bestX = distance
            snappedX = value - anchor.offset
            guideX = value
          }
        }
      }

      for (const anchor of yAnchors) {
        for (const value of candidateY) {
          const distance = Math.abs(anchor.value - value)
          if (distance <= threshold && distance < bestY) {
            bestY = distance
            snappedY = value - anchor.offset
            guideY = value
          }
        }
      }
    }

    return { x: snappedX, y: snappedY, guides: { x: guideX, y: guideY } }
  }

  function startNodeDrag(event: MouseEvent<HTMLDivElement>, nodeId: string) {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const node = nodes.find((item) => item.id === nodeId)
    if (!node) {
      return
    }
    setDraggingId(nodeId)
    dragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
      width: node.width,
      height: node.height,
    }
  }

  function startPan(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 1) {
      return
    }
    event.preventDefault()
    setIsPanning(true)
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    }
  }

  function movePointer(event: MouseEvent<HTMLDivElement>) {
    if (draggingId && dragStartRef.current) {
      const start = dragStartRef.current
      const deltaX = (event.clientX - start.x) / scale
      const deltaY = (event.clientY - start.y) / scale
      const proposedX = start.nodeX + deltaX
      const proposedY = start.nodeY + deltaY
      const snapped = computeSnap(draggingId, proposedX, proposedY, start.width, start.height)
      setGuides(snapped.guides)
      setNodes((prev) =>
        prev.map((node) => (node.id === draggingId ? { ...node, x: snapped.x, y: snapped.y } : node))
      )
      return
    }
    if (isPanning && panStartRef.current) {
      const start = panStartRef.current
      const deltaX = (event.clientX - start.x) / scale
      const deltaY = (event.clientY - start.y) / scale
      setOffset({
        x: start.offsetX - deltaX,
        y: start.offsetY - deltaY,
      })
    }
  }

  function endPointer() {
    if (draggingId) {
      setDraggingId("")
      setGuides({ x: null, y: null })
      dragStartRef.current = null
    }
    if (isPanning) {
      setIsPanning(false)
      panStartRef.current = null
    }
  }

  function zoomAtPoint(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    const worldX = (event.clientX - rect.left) / scale + offset.x
    const worldY = (event.clientY - rect.top) / scale + offset.y
    const nextScale = Math.max(0.4, Math.min(2.2, Number((scale + (event.deltaY > 0 ? -0.08 : 0.08)).toFixed(2))))
    setScale(nextScale)
    setOffset({
      x: worldX - (event.clientX - rect.left) / nextScale,
      y: worldY - (event.clientY - rect.top) / nextScale,
    })
  }

  function updateTextNode(id: string, text: string) {
    setNodes((prev) => prev.map((node) => (node.id === id ? { ...node, text } : node)))
  }

  function handleAssetDragStart(event: React.DragEvent<HTMLDivElement>, asset: Asset) {
    event.dataTransfer.setData("application/kairo-asset", JSON.stringify(asset))
    event.dataTransfer.effectAllowed = "copy"
  }

  function handleCanvasDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const raw = event.dataTransfer.getData("application/kairo-asset")
    if (!raw) {
      return
    }
    const asset = JSON.parse(raw) as Asset
    const world = toWorldPoint(event.clientX, event.clientY)
    createMediaNode(asset, world.x, world.y)
  }

  async function uploadFromCanvas(files: FileList | null) {
    if (!token || !projectId) {
      return
    }
    if (!files || files.length === 0) {
      return
    }
    const folderName = toFolderName(canvasName)
    setUploading(true)
    setMessage("")
    try {
      for (const file of Array.from(files)) {
        const created = await requestJson<CreateArtifactResponse>(
          "/api/v1/storage/artifacts",
          {
            method: "POST",
            body: JSON.stringify({
              projectId,
              taskId: folderName,
              fileName: file.name,
              relativePath: file.name,
              kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file",
              mimeType: file.type || undefined,
              size: file.size,
              status: "pending",
              metadata: {
                canvasName,
                source: "workspace",
              },
              folderSource: "canvas",
              linkedCanvasName: canvasName.trim() || undefined,
            }),
          },
          token
        )
        try {
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
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : "上传失败"
          await requestJson(
            "/api/v1/storage/artifacts",
            {
              method: "PATCH",
              body: JSON.stringify({
                id: created.artifact.id,
                projectId,
                status: "failed",
              }),
            },
            token
          )
          throw new Error(`${message}：${file.name}`)
        }
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
      await loadAssets(token, projectId)
      setMessage(`已上传到文件夹：${folderName}，并写入对象存储`)
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setUploading(false)
    }
  }

  async function sendChat() {
    if (!token || !projectId) {
      return
    }
    if (!chatInput.trim()) {
      setMessage("请输入聊天内容")
      return
    }
    const prompt = chatInput.trim()
    const userMessageAt = new Date().toISOString()
    setMessages((prev) => [...prev, { role: "user", text: prompt, createdAt: userMessageAt }])
    setChatInput("")
    setChatLoading(true)
    try {
      const accepted = await requestJson<ChatResponse>(
        "/api/v1/agent/chat",
        {
          method: "POST",
          body: JSON.stringify({
            sessionId,
            projectId,
            canvasName,
            prompt,
            waitForResult: true,
            timeoutMs: 90000,
          }),
        },
        token
      )
      const syncItems = (accepted.events || []).map((event) => ({
        id: event.id,
        type: event.type,
        data: event.data || {},
        createdAt: event.time,
      }))
      const eventMessages = extractMessagesFromEvents(syncItems)
      if (eventMessages.length > 0) {
        setMessages((prev) => [...prev, ...eventMessages])
      } else {
        setMessages((prev) => [...prev, { role: "event", text: "已完成，但没有可展示内容。", createdAt: new Date().toISOString() }])
      }
      await loadChatSessions(token, projectId, canvasName)
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setChatLoading(false)
    }
  }

  async function createNewChatSession() {
    if (!token || !projectId) {
      return
    }
    const nextSessionId = createChatSessionId(canvasName)
    setSessionId(nextSessionId)
    setMessages([])
    await loadChatSessions(token, projectId, canvasName)
    setMessage("已新建会话")
  }

  async function switchChatSession(nextSessionId: string) {
    if (!token || !projectId || !nextSessionId) {
      return
    }
    setSessionId(nextSessionId)
    await loadChatHistory(token, projectId, nextSessionId)
  }

  function buildCurrentSnapshot(): CanvasSnapshot {
    return {
      nodes,
      messages,
      chatSessions,
      scale,
      offset,
      canvasName,
    }
  }

  async function upsertCanvasRecord(options?: { silent?: boolean }) {
    if (!token || !projectId) {
      return null
    }
    const requestPath = "/api/v1/workspace/canvases"
    const requestBody = activeCanvasId
      ? {
          id: activeCanvasId,
          projectId,
          name: toFolderName(canvasName),
          sessionId,
          snapshot: buildCurrentSnapshot(),
        }
      : {
          projectId,
          name: toFolderName(canvasName),
          sessionId,
          snapshot: buildCurrentSnapshot(),
        }
    const method = activeCanvasId ? "PATCH" : "POST"
    const saved = await requestJson<CanvasItem>(
      requestPath,
      {
        method,
        body: JSON.stringify(requestBody),
      },
      token
    )
    setActiveCanvasId(saved.id)
    await loadCanvases(token, projectId, saved.id)
    if (!options?.silent) {
      setMessage(`已保存画布：${saved.name}`)
    }
    return saved
  }

  async function saveCanvasRecord() {
    if (!token || !projectId) {
      return
    }
    setCanvasSaving(true)
    try {
      await upsertCanvasRecord()
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setCanvasSaving(false)
    }
  }

  async function loadCanvasRecord(item: CanvasItem) {
    if (!token || !projectId) {
      return
    }
    await applyCanvasSnapshot(token, projectId, item)
    setMessage(`已加载画布：${item.name}`)
  }

  async function deleteCanvasRecord(id: string) {
    if (!token || !projectId) {
      return
    }
    try {
      await requestJson(
        `/api/v1/workspace/canvases?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
        token
      )
      if (activeCanvasId === id) {
        setActiveCanvasId("")
      }
      await loadCanvases(token, projectId)
      setMessage("已删除画布")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  async function createCanvasVersion() {
    if (!token || !projectId) {
      return
    }
    setHistorySaving(true)
    try {
      await upsertCanvasRecord({ silent: true })
      const saved = await requestJson<CanvasHistoryItem>(
        "/api/v1/workspace/histories",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            name: createVersionName(canvasName),
            sessionId,
            snapshot: buildCurrentSnapshot(),
          }),
        },
        token
      )
      setActiveHistoryId(saved.id)
      await loadCanvasHistories(token, projectId)
      setMessage(`已创建版本：${saved.name}`)
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setHistorySaving(false)
    }
  }

  async function reloadHistoryToCanvas(history: CanvasHistoryItem) {
    if (!history.snapshot) {
      setMessage("该历史记录没有可用快照")
      return
    }
    setNodes(history.snapshot.nodes)
    setMessages(history.snapshot.messages)
    setChatSessions(history.snapshot.chatSessions || [])
    setScale(history.snapshot.scale)
    setOffset(history.snapshot.offset)
    setCanvasName(history.snapshot.canvasName || history.name)
    const nextSessionId = history.sessionId || createChatSessionId(history.snapshot.canvasName || history.name)
    setSessionId(nextSessionId)
    setActiveHistoryId(history.id)
    if (token && projectId) {
      await Promise.all([
        loadChatSessions(token, projectId, history.snapshot.canvasName || history.name),
        loadChatHistory(token, projectId, nextSessionId),
      ])
    }
    setMessage(`已加载历史：${history.name}`)
  }

  async function deleteCanvasHistory(id: string) {
    if (!token || !projectId) {
      return
    }
    try {
      await requestJson(
        `/api/v1/workspace/histories?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
        token
      )
      if (activeHistoryId === id) {
        setActiveHistoryId("")
      }
      await loadCanvasHistories(token, projectId)
      setMessage("已删除历史记录")
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }

  if (!ready) {
    return null
  }

  return (
    <main className="h-screen w-screen overflow-hidden bg-[oklch(1_0_0)] text-black">
      <div
        ref={viewportRef}
        className="absolute inset-0 overflow-hidden"
        onMouseDown={startPan}
        onMouseMove={movePointer}
        onMouseUp={endPointer}
        onMouseLeave={endPointer}
        onWheel={zoomAtPoint}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleCanvasDrop}
      >
        <div
          style={{
            width: BOARD_SIZE,
            height: BOARD_SIZE,
            transform: `translate(${-offset.x}px, ${-offset.y}px) scale(${scale})`,
            transformOrigin: "top left",
            backgroundImage:
              "linear-gradient(to right, rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.04) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
            position: "relative",
          }}
        >
          {guides.x !== null ? (
            <div className="absolute top-0 h-full border-l border-black/25" style={{ left: guides.x, pointerEvents: "none" }} />
          ) : null}
          {guides.y !== null ? (
            <div className="absolute left-0 w-full border-t border-black/25" style={{ top: guides.y, pointerEvents: "none" }} />
          ) : null}
          {nodes.map((node) => (
            <div
              key={node.id}
              className="absolute rounded-xl border border-black/12 bg-white p-2 shadow-[0_6px_18px_rgba(0,0,0,0.08)]"
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              onMouseDown={(event) => startNodeDrag(event, node.id)}
            >
              <div className="mb-1 flex items-center justify-between">
                <p className="truncate text-xs font-medium">{node.title}</p>
                <Badge variant="outline">{node.type}</Badge>
              </div>
              {node.type === "text" ? (
                <Textarea
                  value={node.text || ""}
                  onChange={(event) => updateTextNode(node.id, event.target.value)}
                  rows={Math.max(4, Math.floor(node.height / 36))}
                  className="h-[calc(100%-32px)] resize-none border-0 p-0 shadow-none focus-visible:ring-0"
                />
              ) : null}
              {node.type === "image" && node.src ? (
                <div className="relative h-[calc(100%-32px)] w-full overflow-hidden rounded-md">
                  <Image src={node.src} alt={node.title} fill unoptimized className="object-cover" />
                </div>
              ) : null}
              {node.type === "video" && node.src ? (
                <video src={node.src} controls className="h-[calc(100%-32px)] w-full rounded-md object-cover" />
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <Card
        onMouseEnter={() => setIsSidebarHover(true)}
        onMouseLeave={() => setIsSidebarHover(false)}
        className={`absolute left-4 top-1/2 z-20 -translate-y-1/2 border-black/10 bg-white/98 transition-all ${
          isSidebarHover ? "w-[280px]" : "w-[64px]"
        }`}
      >
        <CardContent className="p-2">
          {isSidebarHover ? (
            <div className="mt-2 space-y-2">
              <Input value={canvasName} onChange={(event) => setCanvasName(event.target.value)} placeholder="画布名称" />
              <input
                id="workspace-upload-input"
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={(event) => void uploadFromCanvas(event.target.files)}
              />
              <p className="text-[11px] text-black/45">{Math.round(scale * 100)}%</p>
            </div>
          ) : null}

          <div className={`${isSidebarHover ? "mt-2" : "mt-0"} flex flex-col gap-2`}>
            <Button
              size={isSidebarHover ? "default" : "icon"}
              variant="outline"
              className="cursor-pointer"
              onClick={() => addTextNode()}
              title="文本卡片"
            >
              <Type />
              {isSidebarHover ? "文本卡片" : null}
            </Button>
            <Button
              size={isSidebarHover ? "default" : "icon"}
              variant="outline"
              className="cursor-pointer"
              disabled={uploading}
              onClick={() => document.getElementById("workspace-upload-input")?.click()}
              title="上传到当前画布文件夹"
            >
              <Upload />
              {isSidebarHover ? (uploading ? "上传中..." : "上传资产") : null}
            </Button>
            <Button
              size={isSidebarHover ? "default" : "icon"}
              variant="outline"
              className="cursor-pointer"
              onClick={() => setScale((v) => Math.max(0.4, Number((v - 0.1).toFixed(2))))}
              title="缩小"
            >
              <ZoomOut />
              {isSidebarHover ? "缩小" : null}
            </Button>
            <Button
              size={isSidebarHover ? "default" : "icon"}
              variant="outline"
              className="cursor-pointer"
              onClick={() => setScale((v) => Math.min(2.2, Number((v + 0.1).toFixed(2))))}
              title="放大"
            >
              <ZoomIn />
              {isSidebarHover ? "放大" : null}
            </Button>
          </div>

          {isSidebarHover ? (
            <div className="mt-3 space-y-2">
              <p className="text-[11px] text-black/50">拖拽素材到画布可直接放置</p>
              <div className="max-h-44 space-y-2 overflow-auto rounded-md border border-black/8 p-2">
                {mediaAssets.map((asset) => (
                  <div
                    key={asset.id}
                    draggable
                    onDragStart={(event) => handleAssetDragStart(event, asset)}
                    className="cursor-pointer rounded-lg border border-black/8 p-2"
                  >
                    <p className="truncate text-xs font-medium">{asset.fileName}</p>
                    <Button size="sm" variant="outline" className="mt-2 w-full cursor-pointer" onClick={() => addMediaNode(asset)}>
                      上板
                    </Button>
                  </div>
                ))}
                {mediaAssets.length === 0 ? <p className="text-xs text-black/55">暂无可用素材</p> : null}
              </div>
            </div>
          ) : null}

          {isSidebarHover ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-black/50">画布</p>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 cursor-pointer px-2" onClick={resetCanvas}>
                    <Plus />
                    新建
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 cursor-pointer px-2" disabled={canvasSaving} onClick={() => void saveCanvasRecord()}>
                    <Save />
                    {canvasSaving ? "保存中" : "保存"}
                  </Button>
                </div>
              </div>
              <div className="max-h-40 space-y-2 overflow-auto rounded-md border border-black/8 p-2">
                {canvasItems.map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-2 ${item.id === activeCanvasId ? "border-black/30 bg-black/[0.03]" : "border-black/8"}`}
                  >
                    <p className="truncate text-xs font-medium">{item.name}</p>
                    <p className="mt-1 text-[11px] text-black/45">{new Date(item.updatedAt).toLocaleString()}</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="outline" className="w-full cursor-pointer" onClick={() => void loadCanvasRecord(item)}>
                        打开
                      </Button>
                      <Button size="icon" variant="outline" className="cursor-pointer" onClick={() => void deleteCanvasRecord(item.id)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
                {canvasLoading ? <p className="text-xs text-black/55">画布加载中...</p> : null}
                {!canvasLoading && canvasItems.length === 0 ? <p className="text-xs text-black/55">暂无画布，请先创建</p> : null}
              </div>
            </div>
          ) : null}

          {isSidebarHover ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-black/50">版本历史</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 cursor-pointer px-2"
                  disabled={historySaving}
                  onClick={createCanvasVersion}
                >
                  <History />
                  {historySaving ? "创建中" : "创建版本"}
                </Button>
              </div>
              <div className="max-h-40 space-y-2 overflow-auto rounded-md border border-black/8 p-2">
                {historyItems.map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-2 ${item.id === activeHistoryId ? "border-black/30 bg-black/[0.03]" : "border-black/8"}`}
                  >
                    <p className="truncate text-xs font-medium">{item.name}</p>
                    <p className="mt-1 text-[11px] text-black/45">{new Date(item.updatedAt).toLocaleString()}</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="outline" className="w-full cursor-pointer" onClick={() => void reloadHistoryToCanvas(item)}>
                        加载
                      </Button>
                      <Button size="icon" variant="outline" className="cursor-pointer" onClick={() => void deleteCanvasHistory(item.id)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
                {historyLoading ? <p className="text-xs text-black/55">历史加载中...</p> : null}
                {!historyLoading && historyItems.length === 0 ? <p className="text-xs text-black/55">暂无历史记录</p> : null}
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex flex-col gap-2">
            <Link href="/assets">
              <Button size={isSidebarHover ? "default" : "icon"} variant="outline" className="w-full cursor-pointer" title="资产管理">
                <FolderOpen />
                {isSidebarHover ? "资产管理" : null}
              </Button>
            </Link>
            <Link href="/settings">
              <Button size={isSidebarHover ? "default" : "icon"} variant="outline" className="w-full cursor-pointer" title="设置">
                <Settings />
                {isSidebarHover ? "设置" : null}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {chatCollapsed ? (
        <Card className="absolute right-4 top-1/2 z-20 -translate-y-1/2 border-black/10 bg-white/98">
          <CardContent className="p-2">
            <Button
              size="icon"
              className="cursor-pointer"
              onClick={() => setChatCollapsed(false)}
              title="展开聊天"
            >
              <PanelRightOpen />
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="absolute bottom-4 right-4 top-4 z-20 flex w-[340px] flex-col border-black/10 bg-white/98">
          <CardHeader className="border-b border-black/6 pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="text-base">视频图片生成编导</CardTitle>
                <p className="text-xs text-black/50">当前会话：{sessionId}</p>
                <select
                  className="mt-1 h-8 w-[200px] rounded-md border border-black/10 bg-white px-2 text-xs"
                  value={sessionId}
                  onChange={(event) => void switchChatSession(event.target.value)}
                >
                  <option value={sessionId}>{sessionId}</option>
                  {chatSessions
                    .filter((item) => item.sessionId !== sessionId)
                    .map((item) => (
                      <option key={item.sessionId} value={item.sessionId}>
                        {item.sessionId}
                      </option>
                    ))}
                </select>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="cursor-pointer"
                  title="刷新会话"
                  onClick={() => token && projectId && void loadChatSessions(token, projectId, canvasName)}
                >
                  <MessageSquareText />
                </Button>
                <Button size="icon" variant="ghost" className="cursor-pointer" title="新会话" onClick={() => void createNewChatSession()}>
                  <Plus />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="cursor-pointer"
                  onClick={() => setChatCollapsed(true)}
                  title="收起聊天"
                >
                  <PanelRightClose />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
              {sessionListLoading ? <p className="pb-3 text-xs text-black/50">会话列表加载中...</p> : null}
              {chatHistoryLoading ? <p className="pb-3 text-xs text-black/50">会话记录加载中...</p> : null}
              {messages.map((item, index) => (
                <div key={`${item.role}-${index}`} className="flex gap-3 pb-3 last:pb-0">

                  <div className="relative flex-1 pl-4">
                    <span className="absolute left-0 top-[7px] h-2 w-2 rounded-full bg-black/35" />
                    {index < messages.length - 1 ? (
                      <span className="absolute left-[3px] top-3 h-[calc(100%+0.45rem)] w-px bg-black/12" />
                    ) : null}
                    <p className="text-sm font-medium text-black/70">
                      {item.role === "assistant" ? "编导" : item.role === "thought" ? "思考" : item.role === "event" ? "事件" : "你"}
                    </p>
                    <p
                      className={`mt-1 break-words whitespace-pre-wrap text-sm leading-6 ${
                        item.role === "assistant"
                          ? "text-black/80"
                          : item.role === "thought"
                            ? "text-black/60"
                            : item.role === "event"
                              ? "text-black/55"
                              : "text-black/65"
                      }`}
                    >
                      {item.text}
                    </p>
                  </div>
                </div>
              ))}
              {messages.length === 0 ? <p className="text-sm text-black/50">还没有事件</p> : null}
            </div>
            <div className="space-y-2">
              <Textarea
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                rows={3}
                placeholder="输入你想让 Agent 帮你做的内容"
              />
              <Button className="w-full cursor-pointer" disabled={chatLoading} onClick={sendChat}>
                <SendHorizontal />
                {chatLoading ? "发送中..." : "发送到 Agent"}
              </Button>
            </div>
            {message ? <p className="text-xs text-black/65">{message}</p> : null}
          </CardContent>
        </Card>
      )}
    </main>
  )
}
