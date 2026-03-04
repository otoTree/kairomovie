import { createHmac, createHash } from "crypto"

type PresignInput = {
  method: "GET" | "PUT"
  url: URL
  accessKeyId: string
  secretAccessKey: string
  region: string
  service?: string
  expiresInSeconds: number
  contentType?: string
}

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data).digest()
}

function toAmzDate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")
  const yyyy = date.getUTCFullYear()
  const mm = pad(date.getUTCMonth() + 1)
  const dd = pad(date.getUTCDate())
  const hh = pad(date.getUTCHours())
  const mi = pad(date.getUTCMinutes())
  const ss = pad(date.getUTCSeconds())
  return {
    dateStamp: `${yyyy}${mm}${dd}`,
    amzDate: `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`,
  }
}

function encodeRfc3986(input: string) {
  return encodeURIComponent(input).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalQuery(params: URLSearchParams) {
  const pairs: Array<[string, string]> = []
  for (const [k, v] of params.entries()) {
    pairs.push([encodeRfc3986(k), encodeRfc3986(v)])
  }
  pairs.sort(([aK, aV], [bK, bV]) => (aK === bK ? aV.localeCompare(bV) : aK.localeCompare(bK)))
  return pairs.map(([k, v]) => `${k}=${v}`).join("&")
}

function canonicalUri(pathname: string) {
  const parts = pathname.split("/").filter(() => true)
  return parts.map((p) => encodeRfc3986(p)).join("/").replace(/^/, "/")
}

export function presignS3Url(input: PresignInput) {
  const service = input.service ?? "s3"
  const now = new Date()
  const { dateStamp, amzDate } = toAmzDate(now)
  const host = input.url.host
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`
  const signedHeaders = "host"

  const params = new URLSearchParams(input.url.searchParams)
  params.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
  params.set("X-Amz-Credential", `${input.accessKeyId}/${credentialScope}`)
  params.set("X-Amz-Date", amzDate)
  params.set("X-Amz-Expires", String(input.expiresInSeconds))
  params.set("X-Amz-SignedHeaders", signedHeaders)

  const canonicalHeaders = `host:${host}\n`
  const payloadHash = "UNSIGNED-PAYLOAD"
  const canonicalRequest = [
    input.method,
    canonicalUri(input.url.pathname),
    canonicalQuery(params),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n")
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")
  params.set("X-Amz-Signature", signature)

  const finalUrl = new URL(input.url.toString())
  finalUrl.search = params.toString()

  const headers: Record<string, string> = {}
  if (input.method === "PUT" && input.contentType) {
    headers["content-type"] = input.contentType
  }

  return {
    url: finalUrl.toString(),
    method: input.method,
    headers,
    expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString(),
  }
}

