type AppEnv = {
  databaseUrl: string
  authSecret: string
  tokenExpiresInSeconds: number
}

function getEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
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

  cachedEnv = {
    databaseUrl: getEnv("DATABASE_URL"),
    authSecret,
    tokenExpiresInSeconds: getOptionalNumberEnv("AUTH_TOKEN_EXPIRES_IN_SECONDS", 60 * 60 * 24 * 7),
  }
  return cachedEnv
}
