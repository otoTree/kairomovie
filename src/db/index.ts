import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { getAppEnv } from "@/lib/env"
import * as schema from "./schema"

const globalForDb = globalThis as unknown as {
  dbPool?: Pool
}

const dbPool =
  globalForDb.dbPool ??
  new Pool({
    connectionString: getAppEnv().databaseUrl,
    max: 10,
  })

if (process.env.NODE_ENV !== "production") {
  globalForDb.dbPool = dbPool
}

export const db = drizzle(dbPool, { schema })
