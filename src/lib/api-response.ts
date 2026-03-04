import { NextResponse } from "next/server"

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "signature_invalid"
  | "rate_limited"
  | "internal_error"

export function apiOk<T>(data: T, status: number = 200) {
  return NextResponse.json(data, { status })
}

export function apiError(message: string, code: ApiErrorCode, status: number, details?: unknown) {
  return NextResponse.json(
    {
      message,
      code,
      details: details ?? null,
    },
    { status }
  )
}

