"use client"

import Image from "next/image"
import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
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

type Project = {
  id: string
  name: string
}

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
  correlationId: string
}

type EventItem = {
  id: string
  type: string
  data: Record<string, unknown>
}

type Message = {
  role: "user" | "assistant"
  text: string
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

function randomId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function WorkspacePage() {
  const router = useRouter()
  const { ready, token, user } = useAuthSession()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState("")
  const [assets, setAssets] = useState<Asset[]>([])
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [draggingId, setDraggingId] = useState("")
  const [guides, setGuides] = useState<Guides>({ x: null, y: null })
  const [isPanning, setIsPanning] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [sessionId, setSessionId] = useState(`workspace-${Date.now()}`)
  const [message, setMessage] = useState("")
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: BOARD_SIZE / 2 - 700, y: BOARD_SIZE / 2 - 420 })
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<DragStartState | null>(null)
  const panStartRef = useRef<PanStartState | null>(null)

  const mediaAssets = useMemo(() => assets.filter((item) => item.kind === "image" || item.kind === "video"), [assets])

  const loadProjects = useCallback(async (authToken: string) => {
    try {
      const current = await ensureDefaultProject(authToken)
      const rows = await requestJson<Project[]>("/api/v1/projects", { method: "GET" }, authToken)
      setProjects(rows)
      setProjectId(current.id)
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }, [])

  const loadAssets = useCallback(async (authToken: string, nextProjectId: string) => {
    try {
      const result = await requestJson<{ items: Asset[] }>(
        `/api/v1/storage/artifacts?projectId=${encodeURIComponent(nextProjectId)}&limit=200&withUrl=true`,
        { method: "GET" },
        authToken
      )
      setAssets(result.items)
    } catch (error) {
      setMessage(toErrorMessage(error))
    }
  }, [])

  useEffect(() => {
    if (!ready) {
      return
    }
    if (!token || !user) {
      router.replace("/login")
      return
    }
    saveAuth(token, user)
    void loadProjects(token)
  }, [ready, token, user, router, loadProjects])

  useEffect(() => {
    if (!token || !projectId) {
      return
    }
    void loadAssets(token, projectId)
  }, [token, projectId, loadAssets])

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

    return {
      x: snappedX,
      y: snappedY,
      guides: { x: guideX, y: guideY },
    }
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
        prev.map((node) =>
          node.id === draggingId
            ? {
                ...node,
                x: snapped.x,
                y: snapped.y,
              }
            : node
        )
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

  async function sendChat() {
    if (!token) {
      return
    }
    if (!chatInput.trim()) {
      setMessage("请输入聊天内容")
      return
    }
    const prompt = chatInput.trim()
    setMessages((prev) => [...prev, { role: "user", text: prompt }])
    setChatInput("")
    setChatLoading(true)
    try {
      const accepted = await requestJson<ChatResponse>(
        "/api/v1/agent/chat",
        {
          method: "POST",
          body: JSON.stringify({
            sessionId,
            prompt,
            waitForResult: false,
          }),
        },
        token
      )
      const assistantText = await pollAssistantText(accepted.correlationId)
      if (assistantText) {
        setMessages((prev) => [...prev, { role: "assistant", text: assistantText }])
      }
    } catch (error) {
      setMessage(toErrorMessage(error))
    } finally {
      setChatLoading(false)
    }
  }

  async function pollAssistantText(correlationId: string) {
    if (!token) {
      return ""
    }
    for (let i = 0; i < 25; i += 1) {
      const events = await requestJson<{ items: EventItem[] }>(
        `/api/v1/events?correlationId=${encodeURIComponent(correlationId)}&limit=200&fromTime=0&toTime=${Date.now()}`,
        { method: "GET" },
        token
      )
      const text = events.items
        .map((event) => {
          const data = event.data || {}
          const value = data.message || data.text || data.output
          return typeof value === "string" ? value : ""
        })
        .find(Boolean)
      if (text) {
        return text
      }
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    return "已接收请求，Agent 仍在处理中。"
  }

  if (!ready) {
    return null
  }

  return (
    <AppShell user={user} title="工作台" subtitle="无限平移画布 + 资产拖拽 + 节点吸附对齐 + 悬浮 AI 聊天。">
      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card className="h-[calc(100vh-210px)] border-black/6">
          <CardHeader>
            <CardTitle>素材与组件</CardTitle>
          </CardHeader>
          <CardContent className="flex h-[calc(100%-76px)] flex-col gap-3 overflow-auto">
            <div className="rounded-md border border-black/10 bg-[oklch(0.985_0_0)] px-3 py-2 text-sm">
              当前项目：{projects.find((project) => project.id === projectId)?.name || "未命名项目"}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="cursor-pointer" onClick={() => setScale((v) => Math.max(0.4, Number((v - 0.1).toFixed(2))))}>
                缩小
              </Button>
              <Button variant="outline" className="cursor-pointer" onClick={() => setScale((v) => Math.min(2.2, Number((v + 0.1).toFixed(2))))}>
                放大
              </Button>
            </div>
            <Button className="cursor-pointer" onClick={() => addTextNode()}>
              添加文本卡片
            </Button>
            <p className="text-xs text-black/55">当前缩放：{Math.round(scale * 100)}%</p>
            <p className="text-xs text-black/55">中键拖动画布，左键拖动节点，素材可直接拖拽到画布。</p>
            <div className="space-y-2">
              {mediaAssets.map((asset) => (
                <div
                  key={asset.id}
                  draggable
                  onDragStart={(event) => handleAssetDragStart(event, asset)}
                  className="cursor-pointer rounded-xl border border-black/8 p-2"
                >
                  <p className="truncate text-sm font-medium">{asset.fileName}</p>
                  <p className="text-xs text-black/55">{asset.taskId}</p>
                  <p className="line-clamp-2 text-xs text-black/65">
                    {typeof asset.metadata?.content === "string" ? asset.metadata.content : "无 content 描述"}
                  </p>
                  <Button size="sm" variant="outline" className="mt-2 w-full cursor-pointer" onClick={() => addMediaNode(asset)}>
                    加入画布
                  </Button>
                </div>
              ))}
            </div>
            {mediaAssets.length === 0 ? <p className="text-sm text-black/55">资产页先上传图片或视频再回来。</p> : null}
          </CardContent>
        </Card>

        <div className="relative h-[calc(100vh-210px)] overflow-hidden rounded-2xl border border-black/6 bg-[oklch(0.985_0_0)]">
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
                <div
                  className="absolute top-0 h-full border-l border-black/25"
                  style={{ left: guides.x, pointerEvents: "none" }}
                />
              ) : null}
              {guides.y !== null ? (
                <div
                  className="absolute left-0 w-full border-t border-black/25"
                  style={{ top: guides.y, pointerEvents: "none" }}
                />
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

          <Card className="absolute bottom-4 right-4 w-[360px] border-black/10 bg-white/98">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">AI 聊天面板</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="sessionId" />
              <div className="max-h-40 space-y-2 overflow-auto rounded-md border border-black/8 p-2">
                {messages.map((item, index) => (
                  <p key={`${item.role}-${index}`} className={`text-sm ${item.role === "assistant" ? "text-black/80" : "text-black/65"}`}>
                    <span className="mr-1 font-medium">{item.role === "assistant" ? "AI" : "你"}:</span>
                    {item.text}
                  </p>
                ))}
                {messages.length === 0 ? <p className="text-sm text-black/50">还没有对话，试着让 Agent 规划镜头。</p> : null}
              </div>
              <Textarea
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                rows={3}
                placeholder="输入给 Agent 的问题，比如：基于当前画布给我 5 条镜头建议"
              />
              <Button className="w-full cursor-pointer" disabled={chatLoading} onClick={sendChat}>
                {chatLoading ? "发送中..." : "发送到 Agent"}
              </Button>
              {message ? <p className="text-xs text-black/65">{message}</p> : null}
            </CardContent>
          </Card>
        </div>
      </section>
    </AppShell>
  )
}
