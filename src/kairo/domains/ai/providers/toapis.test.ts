import { describe, it, expect } from "bun:test";
import { ToAPIsProvider } from "./toapis";

describe("ToAPIsProvider", () => {
  it("should map model aliases", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const provider = new ToAPIsProvider({ apiKey: "k", baseUrl: "https://toapis.com/v1", defaultModel: "gpt-5" });
      const res = await provider.chat([{ role: "user", content: "hi" }], { model: "gpt5" });
      expect(res.content).toBe("ok");
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toContain("/chat/completions");
      expect(calls[0]!.body.model).toBe("gpt-5");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

