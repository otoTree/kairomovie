import { eq } from "drizzle-orm"
import { db } from "@/db"
import { users } from "@/db/schema"
import { getBearerToken, verifyAuthToken } from "@/lib/auth"

export type AuthUser = {
  id: string
  email: string
}

export async function getAuthUserFromAuthorizationHeader(header: string | null): Promise<AuthUser | null> {
  const token = getBearerToken(header)
  if (!token) {
    return null
  }

  const payload = verifyAuthToken(token)
  if (!payload) {
    return null
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1)

  if (!user) {
    return null
  }

  return user
}
