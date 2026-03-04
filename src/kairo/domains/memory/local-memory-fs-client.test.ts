import { describe, it, expect } from "bun:test";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { LocalMemoryFsClient } from "./local-memory-fs-client";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "kairo-memory-fs-"));
}

describe("LocalMemoryFsClient", () => {
  it("should write/read/list/move/delete in user scope", async () => {
    const basePath = await makeTempDir();
    const client = new LocalMemoryFsClient(basePath);
    const userId = "user-1";

    const write1 = await client.write({
      path: "notes/a.txt",
      userId,
      content: "hello world",
      mode: "overwrite",
    });
    expect(write1.version).toBe(1);
    expect(write1.etag.length).toBeGreaterThan(0);

    const read1 = await client.read({ path: "notes/a.txt", userId, offset: 0, limit: 5 });
    expect(read1.content).toBe("hello");
    expect(read1.eof).toBe(false);

    const list1 = await client.list({ scope: "user", userId, prefix: "notes" });
    expect(list1.files.map((f) => f.path)).toEqual(["notes/a.txt"]);

    const moved = await client.move({ fromPath: "notes/a.txt", toPath: "notes/b.txt", userId });
    expect(moved.success).toBe(true);

    const list2 = await client.list({ scope: "user", userId, prefix: "notes" });
    expect(list2.files.map((f) => f.path)).toEqual(["notes/b.txt"]);

    const removed = await client.remove({ path: "notes/b.txt", userId });
    expect(removed.success).toBe(true);
  });

  it("should keep versions and support rollback", async () => {
    const basePath = await makeTempDir();
    const client = new LocalMemoryFsClient(basePath);
    const userId = "user-1";

    const w1 = await client.write({ path: "notes/a.txt", userId, content: "v1", mode: "overwrite" });
    const w2 = await client.write({ path: "notes/a.txt", userId, content: "v2", mode: "overwrite" });
    expect(w1.version).toBe(1);
    expect(w2.version).toBe(2);

    const versions1 = await client.listVersions({ path: "notes/a.txt", userId });
    expect(versions1.versions.map((v) => v.version)).toEqual([2, 1]);

    const readV1 = await client.readVersion({ path: "notes/a.txt", version: 1, userId });
    expect(readV1.content).toBe("v1");

    const rolled = await client.rollback({ path: "notes/a.txt", toVersion: 1, userId });
    expect(rolled.success).toBe(true);
    expect(rolled.toVersion).toBe(1);
    expect(rolled.version).toBe(3);

    const readAfter = await client.read({ path: "notes/a.txt", userId });
    expect(readAfter.content).toBe("v1");

    const moved = await client.move({ fromPath: "notes/a.txt", toPath: "notes/b.txt", userId });
    expect(moved.success).toBe(true);

    const versions2 = await client.listVersions({ path: "notes/b.txt", userId });
    expect(versions2.versions.map((v) => v.version)).toEqual([3, 2, 1]);

    const removed = await client.remove({ path: "notes/b.txt", userId });
    expect(removed.success).toBe(true);

    const rolledAfterDelete = await client.rollback({ path: "notes/b.txt", toVersion: 2, userId });
    expect(rolledAfterDelete.success).toBe(true);

    const readRestored = await client.read({ path: "notes/b.txt", userId });
    expect(readRestored.content).toBe("v2");
  });

  it("should isolate project scope from user scope", async () => {
    const basePath = await makeTempDir();
    const client = new LocalMemoryFsClient(basePath);
    const userId = "user-1";
    const projectId = "project-1";

    await client.write({ path: "shared.txt", userId, content: "u", mode: "overwrite" });
    await client.write({ path: "shared.txt", userId, projectId, content: "p", mode: "overwrite" });

    const userRead = await client.read({ path: "shared.txt", userId });
    expect(userRead.content).toBe("u");

    const projectRead = await client.read({ path: "shared.txt", userId, projectId });
    expect(projectRead.content).toBe("p");
  });

  it("should search keyword in scope", async () => {
    const basePath = await makeTempDir();
    const client = new LocalMemoryFsClient(basePath);
    const userId = "user-1";

    await client.write({ path: "a.txt", userId, content: "alpha beta gamma", mode: "overwrite" });
    await client.write({ path: "b.txt", userId, content: "delta epsilon", mode: "overwrite" });

    const result = await client.search({ scope: "user", userId, keyword: "beta", limit: 10 });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]!.path).toBe("a.txt");
    expect(result.hits[0]!.snippet.toLowerCase()).toContain("beta");
  });

  it("should reject path traversal", async () => {
    const basePath = await makeTempDir();
    const client = new LocalMemoryFsClient(basePath);
    const userId = "user-1";

    await expect(
      client.write({ path: "../evil.txt", userId, content: "x", mode: "overwrite" })
    ).rejects.toBeDefined();
  });
});
