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
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  waitForResult: z.boolean().optional(),
  memoryWindow: z.number().int().min(1).max(100).optional(),
  projectId: z.string().min(1).max(128).optional(),
  canvasId: z.string().min(1).max(128).optional(),
  canvasName: z.string().min(1).max(128).optional(),
  correlationId: z.string().min(1).max(128).optional(),
  traceId: z.string().min(1).max(128).optional(),
  spanId: z.string().min(1).max(128).optional(),
})

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
  const memoryWindow = parsed.data.memoryWindow ?? 20
  const projectId = parsed.data.projectId
  const canvasId = parsed.data.canvasId?.trim()
  const canvasName = parsed.data.canvasName?.trim()
  if (projectId) {
    await assertProjectAccess(user.id, projectId)
  }
  const correlationId = parsed.data.correlationId || randomUUID()
  const traceId = parsed.data.traceId || correlationId
  const contextSpanId = parsed.data.spanId || randomUUID()
  const memories = await listRecentSessionMemory(user.id, sessionId, memoryWindow, projectId)

  const contextEventPayload = {
    sessionId,
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
      prompt,
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

  const result = await kairo.invokeAgent({
    prompt,
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

  for (const message of result.messages) {
    await appendSessionMemory(user.id, sessionId, {
      role: "assistant",
      content: message,
      eventType: "kairo.agent.action",
      metadata: {
        correlationId: result.correlationId,
        traceId: result.traceId,
        canvasName: canvasName || null,
      },
    }, projectId)
    await appendSessionMemoryEvent(
      user.id,
      sessionId,
      {
        role: "assistant",
        content: message,
        eventType: "kairo.agent.action",
        metadata: {
          correlationId: result.correlationId,
          traceId: result.traceId,
          canvasName: canvasName || null,
        },
      },
      {
        projectId: projectId ?? null,
        correlationId: result.correlationId,
        causationId: result.triggerEventId,
        traceId: result.traceId,
        spanId: randomUUID(),
      }
    )
  }
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
