import type { AICompletionOptions, AIEmbeddingOptions, AIMessage, AIProvider } from "../types";
import { OpenAIProvider, type OpenAIOptions } from "./openai";

export type ToAPIsOptions = Omit<OpenAIOptions, "name"> & {
  modelAliases?: Record<string, string>;
};

const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  "gpt5": "gpt-5",
  "gpt-5": "gpt-5",
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "claude-sonnet-4.5": "claude-sonnet-4.5",
  "claude-haiku-4.5": "claude-haiku-4.5",
  "gemini-2.0-flash": "gemini-2.0-flash",
  "gemini-2.0-flash-thinking": "gemini-2.0-flash-thinking",
  "whisper-1": "whisper-1",
};

function normalizeModel(model: string, aliases: Record<string, string>) {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  const key = trimmed.toLowerCase();
  return aliases[key] || trimmed;
}

export class ToAPIsProvider implements AIProvider {
  readonly name = "toapis";
  private readonly openai: OpenAIProvider;
  private readonly aliases: Record<string, string>;

  constructor(options: ToAPIsOptions = {}) {
    this.openai = new OpenAIProvider({
      name: "toapis",
      apiKey: options.apiKey || process.env.TOAPIS_API_KEY || "",
      baseUrl: options.baseUrl || process.env.TOAPIS_BASE_URL || "https://toapis.com/v1",
      defaultModel: options.defaultModel || process.env.TOAPIS_MODEL_NAME || "gpt-5",
      defaultEmbeddingModel: options.defaultEmbeddingModel || process.env.TOAPIS_EMBEDDING_MODEL_NAME || process.env.OPENAI_EMBEDDING_MODEL_NAME,
    });
    this.aliases = { ...DEFAULT_MODEL_ALIASES, ...(options.modelAliases || {}) };
  }

  async chat(messages: AIMessage[], options?: AICompletionOptions) {
    const model = options?.model ? normalizeModel(options.model, this.aliases) : undefined;
    return this.openai.chat(messages, { ...options, model });
  }

  async embed(text: string, options?: AIEmbeddingOptions) {
    const model = options?.model ? normalizeModel(options.model, this.aliases) : undefined;
    return this.openai.embed(text, { ...options, model });
  }
}

