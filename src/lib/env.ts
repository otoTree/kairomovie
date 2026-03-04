type AppEnv = {
  databaseUrl: string
  authSecret: string
  tokenExpiresInSeconds: number
  nodeEnv: "development" | "test" | "production"
  kairoEventSigningSecret?: string
  kairoDefaultAiProvider?: string
  deployment: "dev" | "staging" | "prod"
  openaiApiKey?: string
  openaiBaseUrl: string
  openaiModelName: string
  openaiEmbeddingBaseUrl?: string
  openaiEmbeddingApiKey?: string
  openaiEmbeddingModelName?: string
  toapisApiKey?: string
  toapisBaseUrl: string
  toapisModelName: string
  tosEndpoint?: string
  tosBucket?: string
  tosAccessKey?: string
  tosSecretKey?: string
  tosRegion?: string
}

function getEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getOptionalNumberEnv(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`)
  }
  return parsed
}

let cachedEnv: AppEnv | null = null

export function getAppEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv
  }

  const authSecret = process.env.AUTH_SECRET || process.env.JWT_SECRET
  if (!authSecret) {
    throw new Error("Missing required environment variable: AUTH_SECRET or JWT_SECRET")
  }

  const nodeEnv = (process.env.NODE_ENV as AppEnv["nodeEnv"] | undefined) ?? "development"
  const vercelEnv = process.env.VERCEL_ENV?.trim()
  const deployment = (() => {
    const explicit = process.env.KAIRO_DEPLOYMENT?.trim()
    if (explicit === "dev" || explicit === "staging" || explicit === "prod") {
      return explicit
    }
    if (vercelEnv === "production") return "prod"
    if (vercelEnv === "preview") return "staging"
    return "dev"
  })()

  cachedEnv = {
    databaseUrl: getEnv("DATABASE_URL"),
    authSecret,
    tokenExpiresInSeconds: getOptionalNumberEnv("AUTH_TOKEN_EXPIRES_IN_SECONDS", 60 * 60 * 24 * 7),
    nodeEnv,
    kairoEventSigningSecret: getOptionalEnv("KAIRO_EVENT_SIGNING_SECRET"),
    kairoDefaultAiProvider: getOptionalEnv("KAIRO_AI_DEFAULT_PROVIDER"),
    deployment,
    openaiApiKey: getOptionalEnv("OPENAI_API_KEY"),
    openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.deepseek.com/v1",
    openaiModelName: process.env.OPENAI_MODEL_NAME?.trim() || "deepseek-chat",
    openaiEmbeddingBaseUrl: getOptionalEnv("OPENAI_EMBEDDING_BASE_URL"),
    openaiEmbeddingApiKey: getOptionalEnv("OPENAI_EMBEDDING_API_KEY"),
    openaiEmbeddingModelName: getOptionalEnv("OPENAI_EMBEDDING_MODEL_NAME"),
    toapisApiKey: getOptionalEnv("TOAPIS_API_KEY"),
    toapisBaseUrl: process.env.TOAPIS_BASE_URL?.trim() || "https://toapis.com/v1",
    toapisModelName: process.env.TOAPIS_MODEL_NAME?.trim() || "gpt-5",
    tosEndpoint: getOptionalEnv("TOS_ENDPOINT"),
    tosBucket: getOptionalEnv("TOS_BUCKET"),
    tosAccessKey: getOptionalEnv("TOS_ACCESS_KEY"),
    tosSecretKey: getOptionalEnv("TOS_SECRET_KEY"),
    tosRegion: getOptionalEnv("TOS_REGION"),
  }
  return cachedEnv
}
