import { NextResponse } from "next/server"
import { getAppEnv } from "@/lib/env"

export const runtime = "nodejs"

export async function GET() {
  const env = getAppEnv()
  return NextResponse.json({
    status: "ok",
    deployment: env.deployment,
    nodeEnv: env.nodeEnv,
  })
}

