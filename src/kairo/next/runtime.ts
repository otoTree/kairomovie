import { randomUUID } from "crypto"
import { Application } from "@/kairo/core/app"
import { AgentPlugin } from "@/kairo/domains/agent/agent.plugin"
import { AIPlugin } from "@/kairo/domains/ai/ai.plugin"
import type { AIProvider } from "@/kairo/domains/ai/types"
import { OpenAIProvider } from "@/kairo/domains/ai/providers/openai"
import { ToAPIsProvider } from "@/kairo/domains/ai/providers/toapis"
import { MemoryPlugin } from "@/kairo/domains/memory/memory.plugin"
import { ToAPIsPlugin } from "@/kairo/domains/toapis/toapis.plugin"
import { VaultPlugin } from "@/kairo/domains/vault/vault.plugin"
import type { KairoEvent } from "@/kairo/domains/events"
import type { EventFilter } from "@/kairo/domains/events"
import { getAppEnv } from "@/lib/env"

export type ChatInput = {
  prompt: string
  targetAgentId?: string
  userId: string
  timeoutMs?: number
  correlationId?: string
}

export type SendUserMessageInput = {
  prompt: string
  targetAgentId?: string
  userId: string
  correlationId?: string
}

export type PublishEventInput = {
  type: string
  source: string
  data: unknown
  correlationId?: string
  causationId?: string
  traceId?: string
  spanId?: string
}

export type ChatOutput = {
  correlationId: string
  triggerEventId: string
  thoughts: string[]
  messages: string[]
  events: KairoEvent[]
}

export class NextKairoRuntime {
  private readonly app = new Application()
  private readonly agent = new AgentPlugin()
  private started = false

  async start() {
    if (this.started) {
      return
    }

    const env = getAppEnv()
    const openai = new OpenAIProvider({
      defaultModel: env.openaiModelName,
      baseUrl: env.openaiBaseUrl,
      apiKey: env.openaiApiKey,
    })
    const providers: AIProvider[] = [openai]
    if (env.toapisApiKey) {
      providers.push(
        new ToAPIsProvider({
          apiKey: env.toapisApiKey,
          baseUrl: env.toapisBaseUrl,
          defaultModel: env.toapisModelName,
        })
      )
    }
    const embeddingBaseUrl = env.openaiEmbeddingBaseUrl
    const embeddingApiKey = env.openaiEmbeddingApiKey || env.openaiApiKey
    if (embeddingBaseUrl) {
      providers.push(
        new OpenAIProvider({
          name: "openai-embedding",
          baseUrl: embeddingBaseUrl,
          apiKey: embeddingApiKey,
          defaultEmbeddingModel: env.openaiEmbeddingModelName || "text-embedding-3-small",
        })
      )
    }

    await this.app.use(new AIPlugin(providers, env.kairoDefaultAiProvider))
    if (env.toapisApiKey) {
      await this.app.use(new ToAPIsPlugin())
    }
    await this.app.use(new MemoryPlugin())
    await this.app.use(new VaultPlugin())
    await this.app.use(this.agent)
    await this.app.start()

    await this.agent.globalBus.publish({
      type: "kairo.system.event",
      source: "system",
      data: {
        type: "system_event",
        name: "startup",
        payload: { message: "Kairo initialized in Next.js runtime" },
      },
    })

    this.started = true
  }

  async sendUserMessage(input: SendUserMessageInput) {
    await this.start()
    const correlationId = input.correlationId || randomUUID()
    const eventId = await this.agent.globalBus.publish({
      type: "kairo.user.message",
      source: `api:user:${input.userId}`,
      data: {
        content: input.prompt,
        targetAgentId: input.targetAgentId,
      },
      correlationId,
    })
    return { eventId, correlationId }
  }

  async publishEvent(input: PublishEventInput) {
    await this.start()
    const correlationId = input.correlationId || randomUUID()
    const eventId = await this.agent.globalBus.publish({
      type: input.type,
      source: input.source,
      data: input.data,
      correlationId,
      causationId: input.causationId,
      traceId: input.traceId,
      spanId: input.spanId,
    })
    return { eventId, correlationId }
  }

  async queryEvents(filter: EventFilter, correlationId?: string) {
    await this.start()
    const events = await this.agent.globalBus.replay(filter)
    if (!correlationId) {
      return events
    }
    return events.filter((event) => event.correlationId === correlationId)
  }

  async chat(input: ChatInput): Promise<ChatOutput> {
    await this.start()
    const timeoutMs = input.timeoutMs ?? 30000
    const thoughts: string[] = []
    const messages: string[] = []
    const events: KairoEvent[] = []

    let resolveDone: (() => void) | null = null
    let rejectDone: ((error: Error) => void) | null = null
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    const { eventId: triggerEventId, correlationId } = await this.sendUserMessage({
      prompt: input.prompt,
      targetAgentId: input.targetAgentId,
      userId: input.userId,
      correlationId: input.correlationId,
    })

    const unsubscribe = this.agent.globalBus.subscribe("kairo.>", (event) => {
      if (event.correlationId !== correlationId) {
        return
      }
      events.push(event)
      if (event.type === "kairo.agent.thought") {
        const thought = (event.data as { thought?: string }).thought
        if (thought) {
          thoughts.push(thought)
        }
      }
      if (event.type === "kairo.agent.action") {
        const action = (event.data as { action?: { type?: string; content?: string } }).action
        if (action?.type && (action.type === "say" || action.type === "query") && action.content) {
          messages.push(action.content)
        }
      }
      if (event.type === "kairo.intent.ended") {
        resolveDone?.()
      }
    })

    const timer = setTimeout(() => {
      rejectDone?.(new Error(`Kairo response timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
      await done
      return {
        correlationId,
        triggerEventId,
        thoughts,
        messages,
        events,
      }
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  }
}

let runtimeSingleton: Promise<NextKairoRuntime> | null = null

export async function getNextKairoRuntime() {
  if (!runtimeSingleton) {
    runtimeSingleton = (async () => {
      const runtime = new NextKairoRuntime()
      await runtime.start()
      return runtime
    })()
  }
  return runtimeSingleton
}
