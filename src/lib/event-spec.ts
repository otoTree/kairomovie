import { randomUUID } from "crypto"

export type StandardEvent = {
  type: string
  source: string
  data: unknown
  correlationId: string
  causationId?: string | null
  traceId?: string | null
  spanId?: string | null
  idempotencyKey?: string | null
}

const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/

export function assertValidEventType(type: string) {
  const trimmed = type.trim()
  if (!trimmed) {
    throw new Error("type 不能为空")
  }
  if (trimmed.length > 256) {
    throw new Error("type 过长")
  }
  if (!EVENT_TYPE_RE.test(trimmed)) {
    throw new Error("type 命名不符合规范")
  }
  return trimmed
}

export function normalizeSource(source: string) {
  const trimmed = source.trim()
  if (!trimmed) {
    throw new Error("source 不能为空")
  }
  if (trimmed.length > 256) {
    throw new Error("source 过长")
  }
  return trimmed
}

export function normalizeOptionalId(value: string | undefined | null) {
  if (value === undefined || value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeIdempotencyKey(value: string | undefined | null) {
  const normalized = normalizeOptionalId(value)
  if (!normalized) {
    return null
  }
  if (normalized.length > 256) {
    throw new Error("idempotencyKey 过长")
  }
  return normalized
}

export function buildStandardEvent(input: {
  type: string
  source: string
  data: unknown
  correlationId?: string
  causationId?: string | null
  traceId?: string | null
  spanId?: string | null
  idempotencyKey?: string | null
}): StandardEvent {
  const type = assertValidEventType(input.type)
  const source = normalizeSource(input.source)
  return {
    type,
    source,
    data: input.data,
    correlationId: normalizeOptionalId(input.correlationId) ?? randomUUID(),
    causationId: normalizeOptionalId(input.causationId),
    traceId: normalizeOptionalId(input.traceId),
    spanId: normalizeOptionalId(input.spanId),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  }
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()

  const normalize = (v: unknown): unknown => {
    if (v === null) return null
    if (typeof v !== "object") return v
    if (seen.has(v as object)) {
      throw new Error("data 不能包含循环引用")
    }
    seen.add(v as object)
    if (Array.isArray(v)) {
      return v.map(normalize)
    }
    const record = v as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      out[k] = normalize(record[k])
    }
    return out
  }

  return JSON.stringify(normalize(value))
}
