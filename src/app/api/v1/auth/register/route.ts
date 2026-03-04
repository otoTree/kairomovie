import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { users } from "@/db/schema"
import { hashPassword, signAuthToken } from "@/lib/auth"

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const parsed = registerSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const email = parsed.data.email.trim().toLowerCase()
  const passwordHash = hashPassword(parsed.data.password)

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing) {
    return NextResponse.json({ message: "邮箱已注册" }, { status: 409 })
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
    })
    .returning({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
    })

  const token = signAuthToken(created)
  return NextResponse.json({
    token,
    user: created,
  })
}
