import type { EventFilter, KairoEvent } from "@/kairo/domains/events"
import {
  getNextKairoRuntime,
  type ChatInput,
  type ChatEventHandler,
  type ChatOutput,
  type PublishEventInput,
  type SendUserMessageInput,
} from "@/kairo/next/runtime"

export type KairoInterface = {
  publishEvent: (input: PublishEventInput) => Promise<{ eventId: string; correlationId: string }>
  sendUserMessage: (input: SendUserMessageInput) => Promise<{ eventId: string; correlationId: string; traceId: string; spanId: string }>
  queryEvents: (filter: EventFilter, correlationId?: string) => Promise<KairoEvent[]>
  invokeAgent: (input: ChatInput) => Promise<ChatOutput>
  invokeAgentStream: (input: ChatInput, onEvent: ChatEventHandler) => Promise<ChatOutput>
}

export async function createKairoInterface(): Promise<KairoInterface> {
  const runtime = await getNextKairoRuntime()
  return {
    publishEvent: (input) => runtime.publishEvent(input),
    sendUserMessage: (input) => runtime.sendUserMessage(input),
    queryEvents: (filter, correlationId) => runtime.queryEvents(filter, correlationId),
    invokeAgent: (input) => runtime.chat(input),
    invokeAgentStream: (input, onEvent) => runtime.chatStream(input, onEvent),
  }
}
