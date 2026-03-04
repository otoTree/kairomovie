import { NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { createKairoInterface } from "@/kairo/interface"

export const runtime = "nodejs"

const publishSchema = z.object({
  type: z.string().min(1).max(256),
  source: z.string().min(1).max(256).optional(),
  data: z.unknown(),
  correlationId: z.string().min(1).max(128).optional(),
  causationId: z.string().min(1).max(128).optional(),
  traceId: z.string().min(1).max(128).optional(),
  spanId: z.string().min(1).max(128).optional(),
})

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = publishSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const kairo = await createKairoInterface()
  const result = await kairo.publishEvent({
    type: parsed.data.type,
    source: parsed.data.source || `api:user:${user.id}`,
    data: parsed.data.data,
    correlationId: parsed.data.correlationId,
    causationId: parsed.data.causationId,
    traceId: parsed.data.traceId,
    spanId: parsed.data.spanId,
  })

  return NextResponse.json({
    status: "accepted",
    eventId: result.eventId,
    correlationId: result.correlationId,
  })
}
