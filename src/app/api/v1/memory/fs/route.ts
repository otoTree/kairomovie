import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { memoryFiles, projects } from "@/db/schema";
import { ensureCloudTables } from "@/db/ensure-cloud-tables";
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth";
import { LocalMemoryFsClient } from "@/kairo/domains/memory/local-memory-fs-client";

export const runtime = "nodejs";

const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("list"),
    scope: z.enum(["user", "project"]),
    projectId: z.string().min(1).max(128).optional(),
    prefix: z.string().min(1).max(512).optional(),
  }),
  z.object({
    op: z.literal("read"),
    projectId: z.string().min(1).max(128).optional(),
    path: z.string().min(1).max(1024),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200000).optional(),
  }),
  z.object({
    op: z.literal("write"),
    projectId: z.string().min(1).max(128).optional(),
    path: z.string().min(1).max(1024),
    content: z.string().max(5_000_000),
    mode: z.enum(["overwrite", "append"]).optional(),
  }),
  z.object({
    op: z.literal("move"),
    projectId: z.string().min(1).max(128).optional(),
    fromPath: z.string().min(1).max(1024),
    toPath: z.string().min(1).max(1024),
  }),
  z.object({
    op: z.literal("delete"),
    projectId: z.string().min(1).max(128).optional(),
    path: z.string().min(1).max(1024),
  }),
  z.object({
    op: z.literal("search"),
    scope: z.enum(["user", "project"]),
    projectId: z.string().min(1).max(128).optional(),
    keyword: z.string().min(1).max(256),
    tags: z.array(z.string().min(1).max(64)).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
]);

async function assertProjectAccess(userId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) {
    throw new Error("项目不存在或无权限");
  }
}

function makeOwnerKey(scope: "user" | "project", userId: string, projectId?: string) {
  if (scope === "project") {
    if (!projectId) {
      throw new Error("projectId 不能为空");
    }
    return `project:${projectId}`;
  }
  return `user:${userId}`;
}

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = opSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 });
  }

  const client = new LocalMemoryFsClient();

  try {
    await ensureCloudTables();
    const input = parsed.data;
    if (input.op === "list") {
      if (input.scope === "project") {
        if (!input.projectId) {
          return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 });
        }
        await assertProjectAccess(user.id, input.projectId);
      }
      const ownerKey = makeOwnerKey(input.scope, user.id, input.projectId);
      const prefix = input.prefix?.trim() || "";
      const where = prefix.length > 0 ? and(eq(memoryFiles.ownerKey, ownerKey), like(memoryFiles.path, `${prefix}%`)) : eq(memoryFiles.ownerKey, ownerKey);
      const indexed = await db
        .select({
          path: memoryFiles.path,
          size: memoryFiles.size,
          updatedAt: memoryFiles.updatedAt,
          etag: memoryFiles.etag,
          version: memoryFiles.version,
          tags: memoryFiles.tags,
        })
        .from(memoryFiles)
        .where(where)
        .orderBy(desc(memoryFiles.updatedAt))
        .limit(500);

      if (indexed.length > 0) {
        return NextResponse.json({
          files: indexed.map((row) => ({
            path: row.path,
            size: row.size,
            updatedAt: row.updatedAt.toISOString(),
            etag: row.etag,
            version: row.version,
            tags: row.tags,
          })),
        });
      }

      return NextResponse.json(
        await client.list({
          scope: input.scope,
          userId: user.id,
          projectId: input.projectId,
          prefix: input.prefix,
        })
      );
    }

    if (input.op === "read") {
      if (input.projectId) {
        await assertProjectAccess(user.id, input.projectId);
      }
      const result = await client.read({
        path: input.path,
        userId: user.id,
        projectId: input.projectId,
        offset: input.offset,
        limit: input.limit,
      });
      return NextResponse.json(result);
    }

    if (input.op === "write") {
      if (input.projectId) {
        await assertProjectAccess(user.id, input.projectId);
      }
      const result = await client.write({
        path: input.path,
        userId: user.id,
        projectId: input.projectId,
        content: input.content,
        mode: input.mode ?? "overwrite",
      });
      const scope: "user" | "project" = input.projectId ? "project" : "user";
      const ownerKey = makeOwnerKey(scope, user.id, input.projectId);
      await db
        .insert(memoryFiles)
        .values({
          ownerKey,
          userId: user.id,
          projectId: input.projectId ?? null,
          scope,
          path: result.path,
          etag: result.etag,
          version: result.version,
          size: result.size,
          tags: [],
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [memoryFiles.ownerKey, memoryFiles.path],
          set: {
            etag: result.etag,
            version: result.version,
            size: result.size,
            updatedAt: new Date(),
          },
        });
      return NextResponse.json(result);
    }

    if (input.op === "move") {
      if (input.projectId) {
        await assertProjectAccess(user.id, input.projectId);
      }
      const result = await client.move({
        fromPath: input.fromPath,
        toPath: input.toPath,
        userId: user.id,
        projectId: input.projectId,
      });
      const scope: "user" | "project" = input.projectId ? "project" : "user";
      const ownerKey = makeOwnerKey(scope, user.id, input.projectId);
      await db
        .delete(memoryFiles)
        .where(and(eq(memoryFiles.ownerKey, ownerKey), eq(memoryFiles.path, result.toPath)));
      await db
        .update(memoryFiles)
        .set({ path: result.toPath, updatedAt: new Date() })
        .where(and(eq(memoryFiles.ownerKey, ownerKey), eq(memoryFiles.path, result.fromPath)));
      return NextResponse.json(result);
    }

    if (input.op === "delete") {
      if (input.projectId) {
        await assertProjectAccess(user.id, input.projectId);
      }
      const result = await client.remove({
        path: input.path,
        userId: user.id,
        projectId: input.projectId,
      });
      if (result.success) {
        const scope: "user" | "project" = input.projectId ? "project" : "user";
        const ownerKey = makeOwnerKey(scope, user.id, input.projectId);
        await db.delete(memoryFiles).where(and(eq(memoryFiles.ownerKey, ownerKey), eq(memoryFiles.path, result.path)));
      }
      return NextResponse.json(result);
    }

    if (input.op === "search") {
      if (input.scope === "project") {
        if (!input.projectId) {
          return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 });
        }
        await assertProjectAccess(user.id, input.projectId);
      }
      const result = await client.search({
        scope: input.scope,
        keyword: input.keyword,
        userId: user.id,
        projectId: input.projectId,
        tags: input.tags,
        limit: input.limit,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ message: "不支持的操作" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败";
    return NextResponse.json({ message }, { status: 400 });
  }
}
