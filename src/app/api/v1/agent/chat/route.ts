import { randomUUID } from "crypto"
import { NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { createKairoInterface } from "@/kairo/interface"
import { appendSessionMemory, appendSessionMemoryEvent, listRecentSessionMemory, syncSessionMemoryMarkdown } from "@/lib/session-memory"

export const runtime = "nodejs"

const chatSchema = z.object({
  sessionId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(20000),
  targetAgentId: z.string().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(1000).max(1800000).optional(),
  waitForResult: z.boolean().optional(),
  streamEvents: z.boolean().optional(),
  memoryWindow: z.number().int().min(1).max(100).optional(),
  projectId: z.string().min(1).max(128).optional(),
  canvasId: z.string().min(1).max(128).optional(),
  canvasName: z.string().min(1).max(128).optional(),
  canvasContext: z.string().max(20000).optional(),
  correlationId: z.string().min(1).max(128).optional(),
  traceId: z.string().min(1).max(128).optional(),
  spanId: z.string().min(1).max(128).optional(),
})

const SSE_HEARTBEAT_INTERVAL_MS = 15000

async function assertProjectAccess(userId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1)
  if (!project) {
    throw new Error("项目不存在或无权限")
  }
}

function mapMemoryRole(role: string) {
  if (role === "assistant" || role === "user" || role === "thought" || role === "event") {
    return role
  }
  if (role === "system") {
    return "event"
  }
  return "event"
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  return value as Record<string, unknown>
}

function toText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function formatTaskOrMediaEvent(type: string, data: Record<string, unknown>): string {
  const kind = toText(data.kind)
  const model = toText(data.model)
  const status = toText(data.providerStatus) || toText(data.status)
  const message = toText(data.message) || toText(data.error)
  const progressRaw = data.progress
  const progress =
    typeof progressRaw === "number"
      ? progressRaw
      : typeof progressRaw === "string"
        ? Number(progressRaw)
        : Number.NaN
  const result = toRecord(data.result)
  const images = Array.isArray(data.images)
    ? data.images.length
    : Array.isArray(result?.images)
      ? result.images.length
      : 0
  const videos = Array.isArray(data.videos)
    ? data.videos.length
    : Array.isArray(result?.videos)
      ? result.videos.length
      : 0
  const taskLabel = `${kind || "任务"}${model ? ` (${model})` : ""}`

  if (type === "kairo.task.started") {
    return `任务已开始: ${taskLabel}`
  }
  if (type === "kairo.task.updated") {
    if (Number.isFinite(progress)) {
      return `任务进度: ${Math.round(progress)}%`
    }
    if (status) {
      return `任务状态: ${status}`
    }
    return `任务状态更新: ${taskLabel}`
  }
  if (type === "kairo.task.completed") {
    if (videos > 0) return `任务完成: 已生成 ${videos} 个视频`
    if (images > 0) return `任务完成: 已生成 ${images} 张图片`
    return `任务已完成: ${taskLabel}`
  }
  if (type === "kairo.task.failed") {
    if (message) return `任务失败: ${message}`
    return `任务失败: ${taskLabel}`
  }
  if (type === "kairo.tool.media.completed") {
    if (videos > 0) return `媒体生成完成: ${videos} 个视频`
    if (images > 0) return `媒体生成完成: ${images} 张图片`
    return "媒体生成完成"
  }
  return ""
}

function extractActionMessage(action: Record<string, unknown>) {
  const candidates = [action.content, action.message, action.text, action.reply, action.response]
  for (const candidate of candidates) {
    const text = toText(candidate)
    if (text) {
      return text
    }
  }
  return ""
}

function toSessionMemoryFromRuntimeEvent(event: { type: string; data: unknown }) {
  const data = toRecord(event.data) || {}
  if (event.type === "kairo.user.message" || event.type === "kairo.session.context") {
    return null
  }
  if (event.type === "kairo.agent.thought") {
    const thought = toText(data.thought)
    if (!thought) return null
    return { role: "thought" as const, content: thought }
  }
  if (event.type === "kairo.agent.action") {
    const action = toRecord(data.action)
    if (!action) return null
    const actionType = toText(action.type)
    const content = extractActionMessage(action)
    if ((actionType === "say" || actionType === "query" || actionType === "speak" || actionType === "reply") && content) {
      return { role: "assistant" as const, content }
    }
    if (content && (!actionType || actionType === "message")) {
      return { role: "assistant" as const, content }
    }
    if (actionType) {
      return { role: "event" as const, content: `动作: ${actionType}` }
    }
    return null
  }
  if (event.type === "kairo.tool.result") {
    const error = toText(data.error)
    if (error) return { role: "event" as const, content: `工具错误: ${error}` }
    const result = toText(data.result)
    if (result) return { role: "event" as const, content: `工具结果: ${result}` }
    return null
  }
  if (event.type === "kairo.intent.started") {
    const intent = toText(data.intent)
    if (!intent) return null
    return { role: "event" as const, content: `开始处理: ${intent}` }
  }
  if (event.type === "kairo.intent.ended") {
    const error = toText(data.error)
    if (error) return { role: "event" as const, content: `处理失败: ${error}` }
    const result = toText(data.result)
    if (result) return { role: "event" as const, content: `处理完成: ${result}` }
    return { role: "event" as const, content: "处理完成" }
  }
  const taskOrMediaText = formatTaskOrMediaEvent(event.type, data)
  if (taskOrMediaText) {
    return { role: "event" as const, content: taskOrMediaText }
  }
  const content = toText(data.content)
  if (!content) return null
  return { role: "event" as const, content }
}

async function persistRuntimeEvents(params: {
  userId: string
  sessionId: string
  projectId?: string
  canvasName?: string
  result: {
    correlationId: string
    traceId: string
    triggerEventId: string
    messages: string[]
    events: Array<{
      id: string
      type: string
      source: string
      time: string
      data: unknown
      correlationId?: string
      causationId?: string
      traceId?: string
      spanId?: string
    }>
  }
}) {
  let persistedCount = 0
  for (const event of params.result.events) {
    const mapped = toSessionMemoryFromRuntimeEvent({
      type: String(event.type || ""),
      data: event.data,
    })
    if (!mapped) {
      continue
    }
    persistedCount += 1
    await appendSessionMemoryEvent(
      params.userId,
      params.sessionId,
      {
        role: mapped.role,
        content: mapped.content,
        eventType: String(event.type || "kairo.session.event"),
        metadata: {
          eventId: event.id,
          source: event.source,
          time: event.time,
          correlationId: event.correlationId ?? params.result.correlationId,
          traceId: event.traceId ?? params.result.traceId,
          spanId: event.spanId ?? null,
          canvasName: params.canvasName || null,
        },
      },
      {
        projectId: params.projectId ?? null,
        correlationId: event.correlationId ?? params.result.correlationId,
        causationId: event.causationId ?? params.result.triggerEventId,
        traceId: event.traceId ?? params.result.traceId,
        spanId: event.spanId ?? randomUUID(),
      }
    )
  }
  if (persistedCount === 0) {
    for (const message of params.result.messages) {
      await appendSessionMemoryEvent(
        params.userId,
        params.sessionId,
        {
          role: "assistant",
          content: message,
          eventType: "kairo.agent.action",
          metadata: {
            correlationId: params.result.correlationId,
            traceId: params.result.traceId,
            canvasName: params.canvasName || null,
          },
        },
        {
          projectId: params.projectId ?? null,
          correlationId: params.result.correlationId,
          causationId: params.result.triggerEventId,
          traceId: params.result.traceId,
          spanId: randomUUID(),
        }
      )
    }
  }
}

function formatSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get("sessionId")?.trim() || ""
  const projectId = searchParams.get("projectId")?.trim() || undefined
  const limitRaw = Number(searchParams.get("limit") || 120)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 120
  if (!sessionId) {
    return NextResponse.json({ message: "sessionId 不能为空" }, { status: 400 })
  }
  if (projectId) {
    await assertProjectAccess(user.id, projectId)
  }
  const items = await listRecentSessionMemory(user.id, sessionId, limit, projectId)
  return NextResponse.json({
    sessionId,
    items: items.map((item) => ({
      role: mapMemoryRole(item.role),
      text: item.content,
      createdAt: item.createdAt,
      eventType: item.eventType,
      metadata: item.metadata ?? {},
    })),
    count: items.length,
  })
}

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = chatSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const kairo = await createKairoInterface()
  const sessionId = parsed.data.sessionId
  const prompt = parsed.data.prompt.trim()
  const waitForResult = parsed.data.waitForResult === true
  const streamEvents = parsed.data.streamEvents === true
  const memoryWindow = parsed.data.memoryWindow ?? 20
  const projectId = parsed.data.projectId
  const canvasId = parsed.data.canvasId?.trim()
  const canvasName = parsed.data.canvasName?.trim()
  const canvasContext = parsed.data.canvasContext?.trim()
  const enrichedPrompt = canvasContext
    ? `【画布节点上下文】\n${canvasContext}\n\n【用户输入】\n${prompt}`
    : prompt
  if (projectId) {
    await assertProjectAccess(user.id, projectId)
  }
  const correlationId = parsed.data.correlationId || randomUUID()
  const traceId = parsed.data.traceId || correlationId
  const contextSpanId = parsed.data.spanId || randomUUID()
  const memories = await listRecentSessionMemory(user.id, sessionId, memoryWindow, projectId)

  const contextEventPayload = {
    sessionId,
    canvasContext: canvasContext || null,
    memory: memories.map((memory) => ({
      role: memory.role,
      content: memory.content,
      eventType: memory.eventType,
      createdAt: memory.createdAt,
    })),
  }

  const contextEvent = await kairo.publishEvent({
    type: "kairo.session.context",
    source: `api:user:${user.id}`,
    data: contextEventPayload,
    correlationId,
    traceId,
    spanId: contextSpanId,
  })

  await appendSessionMemoryEvent(
    user.id,
    sessionId,
    {
      role: "event",
      content: JSON.stringify(contextEventPayload),
      eventType: "kairo.session.context",
      metadata: {
        contextEventId: contextEvent.eventId,
        traceId,
        spanId: contextSpanId,
        canvasName: canvasName || null,
      },
    },
    {
      projectId: projectId ?? null,
      correlationId: contextEvent.correlationId,
      traceId,
      spanId: contextSpanId,
    }
  )

  await appendSessionMemory(user.id, sessionId, {
    role: "user",
    content: prompt,
    eventType: "kairo.user.message",
    metadata: {
      targetAgentId: parsed.data.targetAgentId,
      contextCorrelationId: contextEvent.correlationId,
      traceId,
      canvasName: canvasName || null,
    },
  }, projectId)


  await appendSessionMemoryEvent(
    user.id,
    sessionId,
    {
      role: "user",
      content: prompt,
      eventType: "kairo.user.message",
      metadata: {
        targetAgentId: parsed.data.targetAgentId,
        contextCorrelationId: contextEvent.correlationId,
        traceId,
        canvasName: canvasName || null,
      },
    },
    {
      projectId: projectId ?? null,
      correlationId: contextEvent.correlationId,
      causationId: contextEvent.eventId,
      traceId,
      spanId: randomUUID(),
    }
  )

  if (!waitForResult) {
    const accepted = await kairo.sendUserMessage({
      prompt: enrichedPrompt,
      targetAgentId: parsed.data.targetAgentId,
      userId: user.id,
      projectId,
      canvasId,
      canvasName,
      correlationId: contextEvent.correlationId,
      causationId: contextEvent.eventId,
      traceId,
      spanId: randomUUID(),
    })
    const memoryFile = await syncSessionMemoryMarkdown({
      userId: user.id,
      sessionId,
      projectId,
      canvasName,
      limit: 400,
    }).catch(() => null)
    return NextResponse.json({
      status: "accepted",
      mode: "event",
      sessionId,
      contextEventId: contextEvent.eventId,
      correlationId: accepted.correlationId,
      traceId: accepted.traceId,
      spanId: accepted.spanId,
      eventId: accepted.eventId,
      memoryFile,
    })
  }

  if (streamEvents) {
    const encoder = new TextEncoder()
    const spanId = randomUUID()
    const stream = new ReadableStream({
      start(controller) {
        let closed = false
        let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
          if (closed) {
            return
          }
          try {
            controller.enqueue(
              encoder.encode(
                formatSseEvent("ping", {
                  ts: Date.now(),
                })
              )
            )
          } catch {
            closed = true
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = null
            }
          }
        }, SSE_HEARTBEAT_INTERVAL_MS)
        const push = (event: string, data: unknown) => {
          if (closed) {
            return
          }
          try {
            controller.enqueue(encoder.encode(formatSseEvent(event, data)))
          } catch {
            closed = true
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = null
            }
          }
        }
        const close = () => {
          if (closed) {
            return
          }
          closed = true
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
          controller.close()
        }
        const handle = async () => {
          try {
            push("meta", {
              status: "started",
              sessionId,
              contextEventId: contextEvent.eventId,
              correlationId: contextEvent.correlationId,
              traceId,
              spanId,
            })
            const result = await kairo.invokeAgentStream(
              {
                prompt: enrichedPrompt,
                targetAgentId: parsed.data.targetAgentId,
                timeoutMs: parsed.data.timeoutMs,
                userId: user.id,
                projectId,
                canvasId,
                canvasName,
                correlationId: contextEvent.correlationId,
                causationId: contextEvent.eventId,
                traceId,
                spanId,
              },
              (event) => {
                push("kairo_event", event)
              }
            )

            await persistRuntimeEvents({
              userId: user.id,
              sessionId,
              projectId,
              canvasName,
              result,
            })
            const memoryFile = await syncSessionMemoryMarkdown({
              userId: user.id,
              sessionId,
              projectId,
              canvasName,
              limit: 400,
            }).catch(() => null)
            push("done", {
              status: "completed",
              mode: "stream",
              sessionId,
              contextEventId: contextEvent.eventId,
              correlationId: result.correlationId,
              traceId: result.traceId,
              spanId: result.spanId,
              triggerEventId: result.triggerEventId,
              messages: result.messages,
              thoughts: result.thoughts,
              memoryFile,
            })
          } catch (error) {
            push("error", {
              message: error instanceof Error ? error.message : "会话执行失败",
            })
          } finally {
            close()
          }
        }
        void handle()
      },
      cancel() {},
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  }

  const result = await kairo.invokeAgent({
    prompt: enrichedPrompt,
    targetAgentId: parsed.data.targetAgentId,
    timeoutMs: parsed.data.timeoutMs,
    userId: user.id,
    projectId,
    canvasId,
    canvasName,
    correlationId: contextEvent.correlationId,
    causationId: contextEvent.eventId,
    traceId,
    spanId: randomUUID(),
  })

  await persistRuntimeEvents({
    userId: user.id,
    sessionId,
    projectId,
    canvasName,
    result,
  })
  const memoryFile = await syncSessionMemoryMarkdown({
    userId: user.id,
    sessionId,
    projectId,
    canvasName,
    limit: 400,
  }).catch(() => null)

  return NextResponse.json({
    status: "completed",
    mode: "sync",
    sessionId,
    contextEventId: contextEvent.eventId,
    correlationId: result.correlationId,
    traceId: result.traceId,
    spanId: result.spanId,
    triggerEventId: result.triggerEventId,
    messages: result.messages,
    thoughts: result.thoughts,
    events: result.events,
    memoryFile,
  })
}
