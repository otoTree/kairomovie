import type { Plugin } from "../../core/plugin";
import type { Application } from "../../core/app";
import type { AgentPlugin } from "../agent/agent.plugin";
import { getAppEnv } from "../../../lib/env";
import { randomUUID } from "crypto";

type MediaKind = "image" | "video" | "speech" | "transcription";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`参数 ${key} 无效`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`参数 ${key} 无效`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`参数 ${key} 无效`);
  return value;
}

function readKind(record: Record<string, unknown>): MediaKind {
  const kind = readString(record, "kind");
  if (kind !== "image" && kind !== "video" && kind !== "speech" && kind !== "transcription") {
    throw new Error("参数 kind 无效");
  }
  return kind;
}

function baseUrlJoin(baseUrl: string, path: string) {
  const cleanBase = baseUrl.replace(/\/$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

async function postJson<T>(url: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ToAPIs 请求失败 (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

export class ToAPIsPlugin implements Plugin {
  readonly name = "toapis";
  private app?: Application;

  async setup(app: Application) {
    this.app = app;
    app.registerService("toapis", this);
  }

  start() {
    const agent = this.app?.getService<AgentPlugin>("agent");
    if (!agent) {
      return;
    }

    agent.registerSystemTool(
      {
        name: "kairo_media_generate",
        description: "统一的图像/视频/语音工具接口（ToAPIs OpenAI 兼容端点）",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["image", "video", "speech", "transcription"] },
            prompt: { type: "string" },
            text: { type: "string" },
            size: { type: "string" },
            n: { type: "number" },
            voice: { type: "string" },
            audioBase64: { type: "string" },
            audioFilename: { type: "string" },
            audioContentType: { type: "string" },
            responseFormat: { type: "string" },
            webhook: { type: "string" },
          },
          required: ["kind"],
        },
      },
      async (args: unknown, context: any) => {
        if (!isRecord(args)) {
          throw new Error("参数格式无效");
        }

        const env = getAppEnv();
        const apiKey = env.toapisApiKey;
        if (!apiKey) {
          throw new Error("TOAPIS_API_KEY 未配置");
        }
        const baseUrl = env.toapisBaseUrl;

        const kind = readKind(args);
        const correlationId = context?.correlationId || randomUUID();

        if (kind === "image") {
          const prompt = readString(args, "prompt");
          const model = process.env.TOAPIS_IMAGE_MODEL_NAME || "nano-banana-2";
          const n = readOptionalNumber(args, "n");
          const size = readOptionalString(args, "size");

          const data = await postJson<{
            data?: Array<{ url?: string; b64_json?: string }>;
          }>(baseUrlJoin(baseUrl, "/images/generations"), apiKey, {
            model,
            prompt,
            n,
            size,
          });

          const images = (data.data || []).map((item) => ({
            url: item.url,
            base64: item.b64_json,
          }));

          await agent.globalBus.publish({
            type: "kairo.tool.media.completed",
            source: "tool:toapis",
            data: { kind, model, images },
            correlationId,
          });

          return { kind, model, images };
        }

        if (kind === "speech") {
          const text = readString(args, "text");
          const model = process.env.TOAPIS_TTS_MODEL_NAME || "tts-1";
          const voice = readOptionalString(args, "voice") || process.env.TOAPIS_TTS_VOICE || "alloy";
          const responseFormat = readOptionalString(args, "responseFormat") || "mp3";

          const url = baseUrlJoin(baseUrl, "/audio/speech");
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              input: text,
              voice,
              response_format: responseFormat,
            }),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`ToAPIs 请求失败 (${res.status}): ${body}`);
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const audioBase64 = buf.toString("base64");

          await agent.globalBus.publish({
            type: "kairo.tool.media.completed",
            source: "tool:toapis",
            data: { kind, model, voice, responseFormat, size: buf.length },
            correlationId,
          });

          return { kind, model, voice, responseFormat, audioBase64 };
        }

        if (kind === "transcription") {
          const audioBase64 = readString(args, "audioBase64");
          const audioFilename = readOptionalString(args, "audioFilename") || "audio.wav";
          const audioContentType = readOptionalString(args, "audioContentType") || "audio/wav";
          const model = process.env.TOAPIS_STT_MODEL_NAME || "whisper-1";

          const bytes = Buffer.from(audioBase64, "base64");
          const file = new Blob([bytes], { type: audioContentType });
          const form = new FormData();
          form.set("model", model);
          form.set("file", file, audioFilename);

          const url = baseUrlJoin(baseUrl, "/audio/transcriptions");
          const res = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: form as any,
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`ToAPIs 请求失败 (${res.status}): ${body}`);
          }
          const json = (await res.json()) as { text?: string };
          const text = json.text || "";

          await agent.globalBus.publish({
            type: "kairo.tool.media.completed",
            source: "tool:toapis",
            data: { kind, model, chars: text.length },
            correlationId,
          });

          return { kind, model, text };
        }

        const prompt = readString(args, "prompt");
        const model = process.env.TOAPIS_VIDEO_MODEL_NAME || "sora2";
        const webhook = readOptionalString(args, "webhook");
        const taskId = randomUUID();

        await agent.globalBus.publish({
          type: "kairo.task.started",
          source: "tool:toapis",
          data: {
            taskId,
            provider: "toapis",
            kind,
            model,
            status: "started",
            webhook,
          },
          correlationId,
        });

        const payload: Record<string, unknown> = { model, prompt };
        if (webhook) payload.webhook = webhook;

        const result = await postJson<Record<string, unknown>>(baseUrlJoin(baseUrl, "/videos/generations"), apiKey, payload);

        await agent.globalBus.publish({
          type: "kairo.task.updated",
          source: "tool:toapis",
          data: {
            taskId,
            provider: "toapis",
            kind,
            model,
            status: "submitted",
            result,
          },
          correlationId,
        });

        return { kind, model, taskId, submitted: true, result };
      }
    );
  }
}
