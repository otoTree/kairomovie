import { NextResponse } from "next/server"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { getRecommendedBucketLayout, getRecommendedLifecycleRules } from "@/lib/storage-policy"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  return NextResponse.json({
    layout: getRecommendedBucketLayout(),
    lifecycle: getRecommendedLifecycleRules(),
  })
}

