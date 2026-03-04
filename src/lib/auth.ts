import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto"
import { getAppEnv } from "@/lib/env"

type AuthTokenPayload = {
  sub: string
  email: string
  exp: number
  iat: number
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8")
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const iterations = 120000
  const derived = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex")
  return `pbkdf2$${iterations}$${salt}$${derived}`
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$")
  if (parts.length !== 4 || parts[0] !== "pbkdf2") {
    return false
  }

  const iterations = Number(parts[1])
  const salt = parts[2]
  const expected = parts[3]
  if (!Number.isFinite(iterations) || !salt || !expected) {
    return false
  }

  const computed = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex")
  const expectedBuffer = Buffer.from(expected, "hex")
  const computedBuffer = Buffer.from(computed, "hex")
  if (expectedBuffer.length !== computedBuffer.length) {
    return false
  }
  return timingSafeEqual(expectedBuffer, computedBuffer)
}

function signData(data: string): string {
  return base64UrlEncode(createHmac("sha256", getAppEnv().authSecret).update(data).digest())
}

export function signAuthToken(user: { id: string; email: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000)
  const payload: AuthTokenPayload = {
    sub: user.id,
    email: user.email,
    iat: issuedAt,
    exp: issuedAt + getAppEnv().tokenExpiresInSeconds,
  }

  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = base64UrlEncode(JSON.stringify(payload))
  const signature = signData(`${header}.${body}`)
  return `${header}.${body}.${signature}`
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const [header, body, signature] = token.split(".")
  if (!header || !body || !signature) {
    return null
  }

  const expectedSignature = signData(`${header}.${body}`)
  const signatureBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null
  }
  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body)) as AuthTokenPayload
    if (!payload.sub || !payload.email || !payload.exp || !payload.iat) {
      return null
    }
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp <= now) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export function getBearerToken(value: string | null): string | null {
  if (!value) {
    return null
  }
  const [scheme, token] = value.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null
  }
  return token
}
