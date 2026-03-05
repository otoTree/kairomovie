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

function readOptionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`参数 ${key} 无效`);
  return value as Record<string, unknown>;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`参数 ${key} 无效`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`参数 ${key} 无效`);
    }
    out.push(item.trim());
  }
  return out;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`参数 ${key} 无效`);
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

async function getJson<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ToAPIs 查询失败 (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function pickTaskId(result: Record<string, unknown>): string | undefined {
  const directCandidates = ["taskId", "task_id", "id", "jobId", "job_id", "requestId", "request_id"];
  for (const key of directCandidates) {
    const value = result[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const nested = result.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return pickTaskId(nested as Record<string, unknown>);
  }
  return undefined;
}

function pickTaskStatus(result: Record<string, unknown>): string | undefined {
  const directCandidates = ["status", "state"];
  for (const key of directCandidates) {
    const value = result[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const nested = result.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return pickTaskStatus(nested as Record<string, unknown>);
  }
  return undefined;
}

function pickTaskProgress(result: Record<string, unknown>): number | undefined {
  const directCandidates = ["progress"];
  for (const key of directCandidates) {
    const value = result[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  const nested = result.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return pickTaskProgress(nested as Record<string, unknown>);
  }
  return undefined;
}

function pickTaskError(result: Record<string, unknown>): string | undefined {
  const error = result.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  const message = result.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }
  return undefined;
}

function pickImages(result: Record<string, unknown>) {
  let data: unknown = result.data;
  const nestedResult = result.result;
  if (!Array.isArray(data) && nestedResult && typeof nestedResult === "object" && !Array.isArray(nestedResult)) {
    data = (nestedResult as Record<string, unknown>).data;
  }
  if (!Array.isArray(data)) {
    return [] as Array<{ url?: string; base64?: string }>;
  }
  const images: Array<{ url?: string; base64?: string }> = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url : undefined;
    const base64 = typeof row.b64_json === "string" ? row.b64_json : undefined;
    if (!url && !base64) {
      continue;
    }
    images.push({ url, base64 });
  }
  return images;
}

function pickVideos(result: Record<string, unknown>) {
  let data: unknown = result.data;
  const nestedResult = result.result;
  if (!Array.isArray(data) && nestedResult && typeof nestedResult === "object" && !Array.isArray(nestedResult)) {
    data = (nestedResult as Record<string, unknown>).data;
  }
  if (!Array.isArray(data)) {
    return [] as Array<{ url?: string; format?: string }>;
  }
  const videos: Array<{ url?: string; format?: string }> = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url : undefined;
    const format = typeof row.format === "string" ? row.format : undefined;
    if (!url) {
      continue;
    }
    videos.push({ url, format });
  }
  return videos;
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
            model: { type: "string" },
            size: { type: "string" },
            n: { type: "number" },
            duration: { type: "number" },
            aspectRatio: { type: "string" },
            imageUrls: { type: "array", items: { type: "string" } },
            metadata: { type: "object" },
            voice: { type: "string" },
            audioBase64: { type: "string" },
            audioFilename: { type: "string" },
            audioContentType: { type: "string" },
            responseFormat: { type: "string" },
            webhook: { type: "string" },
            waitForCompletion: { type: "boolean" },
            pollIntervalMs: { type: "number" },
            timeoutMs: { type: "number" },
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
          const model = readOptionalString(args, "model") || process.env.TOAPIS_IMAGE_MODEL_NAME || "nano-banana-2";
          const n = readOptionalNumber(args, "n");
          const size = readOptionalString(args, "size");
          const imageUrls = readOptionalStringArray(args, "imageUrls");
          const metadata = readOptionalRecord(args, "metadata");
          const webhook = readOptionalString(args, "webhook");
          const waitForCompletion = readOptionalBoolean(args, "waitForCompletion") ?? true;
          const pollIntervalMs = readOptionalNumber(args, "pollIntervalMs") ?? 3000;
          const timeoutMs = readOptionalNumber(args, "timeoutMs") ?? 120000;
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
          if (typeof n === "number") payload.n = n;
          if (size) payload.size = size;
          if (imageUrls && imageUrls.length > 0) payload.image_urls = imageUrls;
          if (metadata) payload.metadata = metadata;
          if (webhook) payload.webhook = webhook;

          const result = await postJson<Record<string, unknown>>(baseUrlJoin(baseUrl, "/images/generations"), apiKey, payload);
          const providerTaskId = pickTaskId(result);
          const providerStatus = pickTaskStatus(result);

          await agent.globalBus.publish({
            type: "kairo.task.updated",
            source: "tool:toapis",
            data: {
              taskId,
              providerTaskId,
              provider: "toapis",
              kind,
              model,
              status: "submitted",
              providerStatus,
              result,
            },
            correlationId,
          });

          if (providerStatus === "failed") {
            await agent.globalBus.publish({
              type: "kairo.task.failed",
              source: "tool:toapis",
              data: {
                taskId,
                providerTaskId,
                provider: "toapis",
                kind,
                model,
                status: "failed",
                result,
              },
              correlationId,
            });
            throw new Error(`ToAPIs 图像任务失败: ${JSON.stringify(result)}`);
          }

          if (!waitForCompletion) {
            return { kind, model, taskId, providerTaskId, providerStatus, submitted: true, result };
          }

          const pollStartAt = Date.now();
          let finalResult = result;
          let finalStatus = providerStatus;

          if (providerTaskId && providerStatus !== "completed") {
            while (Date.now() - pollStartAt < timeoutMs) {
              await sleep(pollIntervalMs);
              const polled = await getJson<Record<string, unknown>>(
                baseUrlJoin(baseUrl, `/images/generations/${encodeURIComponent(providerTaskId)}`),
                apiKey
              );
              finalResult = polled;
              finalStatus = pickTaskStatus(polled) || finalStatus;
              const progress = pickTaskProgress(polled);
              await agent.globalBus.publish({
                type: "kairo.task.updated",
                source: "tool:toapis",
                data: {
                  taskId,
                  providerTaskId,
                  provider: "toapis",
                  kind,
                  model,
                  status: "polling",
                  providerStatus: finalStatus,
                  progress,
                  result: polled,
                },
                correlationId,
              });

              if (finalStatus === "completed" || finalStatus === "failed") {
                break;
              }
            }
          }

          const images = pickImages(finalResult);
          if (finalStatus === "failed") {
            const message = pickTaskError(finalResult) || "图像任务失败";
            await agent.globalBus.publish({
              type: "kairo.task.failed",
              source: "tool:toapis",
              data: {
                taskId,
                providerTaskId,
                provider: "toapis",
                kind,
                model,
                status: "failed",
                result: finalResult,
                message,
              },
              correlationId,
            });
            throw new Error(`ToAPIs 图像任务失败: ${message}`);
          }

          if (finalStatus !== "completed" && images.length === 0) {
            await agent.globalBus.publish({
              type: "kairo.task.failed",
              source: "tool:toapis",
              data: {
                taskId,
                providerTaskId,
                provider: "toapis",
                kind,
                model,
                status: "failed",
                message: "图像任务轮询超时",
                result: finalResult,
              },
              correlationId,
            });
            throw new Error("ToAPIs 图像任务轮询超时");
          }

          if (images.length > 0) {
            await agent.globalBus.publish({
              type: "kairo.tool.media.completed",
              source: "tool:toapis",
              data: { kind, model, images },
              correlationId,
            });
            await agent.globalBus.publish({
              type: "kairo.task.completed",
              source: "tool:toapis",
              data: {
                taskId,
                providerTaskId,
                provider: "toapis",
                kind,
                model,
                status: "completed",
                result: { images },
              },
              correlationId,
            });
          }

          return {
            kind,
            model,
            taskId,
            providerTaskId,
            providerStatus: finalStatus,
            submitted: true,
            completed: true,
            images,
            result: finalResult,
          };
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
        const model = readOptionalString(args, "model") || process.env.TOAPIS_VIDEO_MODEL_NAME || "sora2";
        const duration = readOptionalNumber(args, "duration");
        const aspectRatio = readOptionalString(args, "aspectRatio");
        const imageUrls = readOptionalStringArray(args, "imageUrls");
        const metadata = readOptionalRecord(args, "metadata");
        const webhook = readOptionalString(args, "webhook");
        const waitForCompletion = readOptionalBoolean(args, "waitForCompletion") ?? true;
        const pollIntervalMs = readOptionalNumber(args, "pollIntervalMs") ?? 10000;
        const timeoutMs = readOptionalNumber(args, "timeoutMs") ?? 600000;
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
        if (typeof duration === "number") payload.duration = duration;
        if (aspectRatio) payload.aspect_ratio = aspectRatio;
        if (imageUrls && imageUrls.length > 0) payload.image_urls = imageUrls;
        if (metadata) payload.metadata = metadata;
        if (webhook) payload.webhook = webhook;

        const result = await postJson<Record<string, unknown>>(baseUrlJoin(baseUrl, "/videos/generations"), apiKey, payload);
        const providerTaskId = pickTaskId(result);
        const providerStatus = pickTaskStatus(result);

        await agent.globalBus.publish({
          type: "kairo.task.updated",
          source: "tool:toapis",
          data: {
            taskId,
            providerTaskId,
            provider: "toapis",
            kind,
            model,
            status: "submitted",
            providerStatus,
            result,
          },
          correlationId,
        });

        if (providerStatus === "failed") {
          await agent.globalBus.publish({
            type: "kairo.task.failed",
            source: "tool:toapis",
            data: {
              taskId,
              providerTaskId,
              provider: "toapis",
              kind,
              model,
              status: "failed",
              result,
            },
            correlationId,
          });
          throw new Error(`ToAPIs 视频任务失败: ${JSON.stringify(result)}`);
        }

        if (!waitForCompletion) {
          return { kind, model, taskId, providerTaskId, providerStatus, submitted: true, result };
        }

        let finalResult = result;
        let finalStatus = providerStatus;
        const pollStartAt = Date.now();
        if (providerTaskId && providerStatus !== "completed") {
          while (Date.now() - pollStartAt < timeoutMs) {
            await sleep(pollIntervalMs);
            const polled = await getJson<Record<string, unknown>>(
              baseUrlJoin(baseUrl, `/videos/generations/${encodeURIComponent(providerTaskId)}`),
              apiKey
            );
            finalResult = polled;
            finalStatus = pickTaskStatus(polled) || finalStatus;
            const progress = pickTaskProgress(polled);
            await agent.globalBus.publish({
              type: "kairo.task.updated",
              source: "tool:toapis",
              data: {
                taskId,
                providerTaskId,
                provider: "toapis",
                kind,
                model,
                status: "polling",
                providerStatus: finalStatus,
                progress,
                result: polled,
              },
              correlationId,
            });
            if (finalStatus === "completed" || finalStatus === "failed") {
              break;
            }
          }
        }

        const videos = pickVideos(finalResult);
        if (finalStatus === "failed") {
          const message = pickTaskError(finalResult) || "视频任务失败";
          await agent.globalBus.publish({
            type: "kairo.task.failed",
            source: "tool:toapis",
            data: {
              taskId,
              providerTaskId,
              provider: "toapis",
              kind,
              model,
              status: "failed",
              message,
              result: finalResult,
            },
            correlationId,
          });
          throw new Error(`ToAPIs 视频任务失败: ${message}`);
        }

        if (finalStatus !== "completed" && videos.length === 0) {
          await agent.globalBus.publish({
            type: "kairo.task.failed",
            source: "tool:toapis",
            data: {
              taskId,
              providerTaskId,
              provider: "toapis",
              kind,
              model,
              status: "failed",
              message: "视频任务轮询超时",
              result: finalResult,
            },
            correlationId,
          });
          throw new Error("ToAPIs 视频任务轮询超时");
        }

        await agent.globalBus.publish({
          type: "kairo.tool.media.completed",
          source: "tool:toapis",
          data: { kind, model, videos },
          correlationId,
        });
        await agent.globalBus.publish({
          type: "kairo.task.completed",
          source: "tool:toapis",
          data: {
            taskId,
            providerTaskId,
            provider: "toapis",
            kind,
            model,
            status: "completed",
            result: { videos },
          },
          correlationId,
        });

        return {
          kind,
          model,
          taskId,
          providerTaskId,
          providerStatus: finalStatus,
          submitted: true,
          completed: true,
          videos,
          result: finalResult,
        };
      }
    );
  }
}
