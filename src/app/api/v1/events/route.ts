import { NextResponse } from "next/server"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { createKairoInterface } from "@/kairo/interface"

export const runtime = "nodejs"

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const correlationId = searchParams.get("correlationId") || undefined
  const fromTime = parsePositiveInt(searchParams.get("fromTime"), 0)
  const toTime = parsePositiveInt(searchParams.get("toTime"), Date.now())
  const limit = parsePositiveInt(searchParams.get("limit"), 100)
  const types = searchParams.getAll("type")
  const sources = searchParams.getAll("source")

  const kairo = await createKairoInterface()
  const events = await kairo.queryEvents(
    {
      fromTime,
      toTime,
      limit,
      types: types.length > 0 ? types : undefined,
      sources: sources.length > 0 ? sources : undefined,
    },
    correlationId
  )

  return NextResponse.json({
    items: events,
    count: events.length,
  })
}
