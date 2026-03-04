import { randomUUID } from "crypto"
import { NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { createKairoInterface } from "@/kairo/interface"
import { appendSessionMemory, appendSessionMemoryEvent, listRecentSessionMemory } from "@/lib/session-memory"

export const runtime = "nodejs"

const chatSchema = z.object({
  sessionId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(20000),
  targetAgentId: z.string().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  waitForResult: z.boolean().optional(),
  memoryWindow: z.number().int().min(1).max(100).optional(),
  correlationId: z.string().min(1).max(128).optional(),
  traceId: z.string().min(1).max(128).optional(),
  spanId: z.string().min(1).max(128).optional(),
})

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
  const correlationId = parsed.data.correlationId || randomUUID()
  const traceId = parsed.data.traceId || correlationId
  const contextSpanId = parsed.data.spanId || randomUUID()
  const memories = await listRecentSessionMemory(user.id, sessionId, memoryWindow)

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
      },
    },
    {
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
    },
  })


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
      },
    },
    {
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
      correlationId: contextEvent.correlationId,
      causationId: contextEvent.eventId,
      traceId,
      spanId: randomUUID(),
    })
    return NextResponse.json({
      status: "accepted",
      mode: "event",
      sessionId,
      contextEventId: contextEvent.eventId,
      correlationId: accepted.correlationId,
      traceId: accepted.traceId,
      spanId: accepted.spanId,
      eventId: accepted.eventId,
    })
  }

  const result = await kairo.invokeAgent({
    prompt,
    targetAgentId: parsed.data.targetAgentId,
    timeoutMs: parsed.data.timeoutMs,
    userId: user.id,
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
      },
    })
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
        },
      },
      {
        correlationId: result.correlationId,
        causationId: result.triggerEventId,
        traceId: result.traceId,
        spanId: randomUUID(),
      }
    )
  }

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
  })
}
