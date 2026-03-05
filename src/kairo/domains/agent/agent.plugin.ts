import type { Plugin } from "../../core/plugin";
import type { Application } from "../../core/app";
import type { AIPlugin } from "../ai/ai.plugin";
import type { MCPPlugin } from "../mcp/mcp.plugin";
import { LegacyObservationBusAdapter, type ObservationBus } from "./observation-bus";
import { InMemoryAgentMemory, type AgentMemory } from "./memory";
import { InMemorySharedMemory, type SharedMemory } from "./shared-memory";
import { AgentRuntime, type SystemTool } from "./runtime";
import { InMemoryGlobalBus, RingBufferEventStore, type EventBus, type KairoEvent } from "../events";
import type { Vault } from "../vault/vault";
import type { MemoryStore } from "../memory/memory-store";
import { CapabilityRegistry, type AgentCapability } from "./capability-registry";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { ensureCloudTables } from "@/db/ensure-cloud-tables";
import { apiCanvases } from "@/db/schema";

type WorkspaceCanvasNode = {
  id: string;
  type: "text" | "image" | "video";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  src?: string;
  title: string;
  content?: string;
};

type WorkspaceCanvasSnapshot = {
  nodes: WorkspaceCanvasNode[];
  messages: Array<{ role: "user" | "assistant" | "thought" | "event"; text: string; createdAt?: string }>;
  chatSessions?: Array<{ sessionId: string; lastAt: string; messageCount: number; lastMessage: string }>;
  scale: number;
  offset: { x: number; y: number };
  canvasName: string;
};

export class AgentPlugin implements Plugin {
  readonly name = "agent";
  
  public readonly globalBus: EventBus;
  public readonly bus: ObservationBus; // Legacy adapter exposed as bus for compatibility
  public readonly memory: AgentMemory; // Kept for legacy/default agent
  public readonly sharedMemory: SharedMemory;

  private agents: Map<string, AgentRuntime> = new Map();
  private activeAgentId: string = "default";
  // 能力注册表
  public readonly capabilityRegistry = new CapabilityRegistry();
  
  private app?: Application;
  private actionListeners: ((action: any) => void)[] = [];
  private logListeners: ((log: any) => void)[] = [];
  private actionResultListeners: ((result: any) => void)[] = [];
  
  private ai?: AIPlugin;
  private mcp?: MCPPlugin;
  private vault?: Vault;
  private memoryStore?: MemoryStore;
  private systemTools: SystemTool[] = [];

  constructor() {
    this.globalBus = new InMemoryGlobalBus(new RingBufferEventStore());
    this.bus = new LegacyObservationBusAdapter(this.globalBus);
    this.memory = new InMemoryAgentMemory();
    this.sharedMemory = new InMemorySharedMemory();
  }

  registerSystemTool(definition: any, handler: (args: any, context: any) => Promise<any>) {
    const tool = { definition, handler };
    this.systemTools.push(tool);
    // Dynamically add to existing agents
    for (const agent of this.agents.values()) {
        agent.registerSystemTool(definition, handler);
    }
  }

  onAction(listener: (action: any) => void) {
    this.actionListeners.push(listener);
    return () => {
      this.actionListeners = this.actionListeners.filter(l => l !== listener);
    };
  }

  onLog(listener: (log: any) => void) {
    this.logListeners.push(listener);
    return () => {
      this.logListeners = this.logListeners.filter(l => l !== listener);
    };
  }

  onActionResult(listener: (result: any) => void) {
    this.actionResultListeners.push(listener);
    return () => {
      this.actionResultListeners = this.actionResultListeners.filter(l => l !== listener);
    };
  }

  public getAgent(id: string): AgentRuntime | undefined {
    return this.agents.get(id);
  }

  setup(app: Application) {
    this.app = app;
    console.log("[Agent] Setting up Agent domain...");
    app.registerService("agent", this);
  }

  async start() {
    if (!this.app) {
      throw new Error("AgentPlugin not initialized");
    }

    console.log("[Agent] Starting Agent domain...");
    
    try {
      this.ai = this.app.getService<AIPlugin>("ai");
    } catch (e) {
      console.error("[Agent] AI service not found. Agent cannot start.");
      throw e;
    }

    try {
      this.mcp = this.app.getService<MCPPlugin>("mcp");
    } catch (e) {
      console.warn("[Agent] MCP service not found. Tools will be disabled.");
    }

    try {
        this.vault = this.app.getService<Vault>("vault");
    } catch (e) {
        console.warn("[Agent] Vault service not found.");
    }

    try {
        this.memoryStore = this.app.getService<MemoryStore>("memoryStore");
    } catch (e) {
        console.warn("[Agent] MemoryStore service not found.");
    }

    // Spawn default agent
    // If MemoryStore is available, inject it into the default memory
    if (this.memoryStore && this.memory instanceof InMemoryAgentMemory) {
        this.memory.setLongTermMemory(this.memoryStore);
    }

    this.spawnAgent("default", this.memory);

    // Subscribe to user messages for routing
    this.globalBus.subscribe("kairo.user.message", this.handleUserMessage.bind(this));

    // 订阅能力声明事件
    this.globalBus.subscribe("kairo.agent.capability", (event: KairoEvent) => {
      const data = event.data as AgentCapability;
      if (data?.agentId && data?.name) {
        this.capabilityRegistry.register(data);
      }
    });

    // 注册任务委派工具
    this.registerSystemTool({
      name: "delegate_task",
      description: "将任务委派给另一个 Agent",
      inputSchema: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "目标 Agent ID，留空则自动路由" },
          description: { type: "string", description: "任务描述" },
          input: { type: "object", description: "任务输入数据" },
        },
        required: ["description"],
      },
    }, async (args: any, context: any) => {
      const targetId = args.targetAgentId || this.capabilityRegistry.findBestAgent(args.description)?.agentId || crypto.randomUUID();
      const taskId = await this.delegateTask(context.agentId, targetId, {
        description: args.description,
        input: args.input,
      });
      return { taskId, targetAgentId: targetId };
    });

    // 注册能力查询工具
    this.registerSystemTool({
      name: "list_agent_capabilities",
      description: "列出所有已注册 Agent 的能力",
      inputSchema: { type: "object", properties: {} },
    }, async () => {
      return { capabilities: this.capabilityRegistry.getAllCapabilities() };
    });

    this.registerSystemTool({
      name: "kairo_canvas_add_text",
      description: "向前端画布添加文本节点",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "用户 ID" },
          projectId: { type: "string", description: "项目 ID" },
          canvasId: { type: "string", description: "画布 ID（可选）" },
          canvasName: { type: "string", description: "画布名称（未传 canvasId 时用于定位）" },
          createIfMissing: { type: "boolean", description: "未找到画布时是否自动创建" },
          title: { type: "string", description: "节点标题" },
          text: { type: "string", description: "文本内容" },
          x: { type: "number", description: "X 坐标" },
          y: { type: "number", description: "Y 坐标" },
          width: { type: "number", description: "宽度" },
          height: { type: "number", description: "高度" },
        },
        required: ["userId", "projectId", "text"],
      },
    }, async (args: any, context: any) => {
      const toolArgs = this.mergeCanvasToolArgs(args, context);
      const { userId, projectId } = await this.resolveCanvasScope(toolArgs);
      const text = this.requireString(args, "text");
      const target = await this.findCanvasForTool(toolArgs, userId, projectId, toolArgs?.createIfMissing === true);
      const snapshot = this.normalizeCanvasSnapshot(target.snapshot, target.name);
      const nodeId = `node-${crypto.randomUUID().slice(0, 8)}`;
      const node: WorkspaceCanvasNode = {
        id: nodeId,
        type: "text",
        x: this.optionalNumber(args, "x") ?? 120,
        y: this.optionalNumber(args, "y") ?? 120,
        width: this.optionalNumber(args, "width") ?? 360,
        height: this.optionalNumber(args, "height") ?? 180,
        title: this.optionalString(args, "title") || "文本",
        text,
      };
      snapshot.nodes.push(node);
      const [updated] = await db
        .update(apiCanvases)
        .set({ snapshot: snapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(apiCanvases.id, target.id), eq(apiCanvases.userId, userId), eq(apiCanvases.projectId, projectId)))
        .returning({ id: apiCanvases.id, name: apiCanvases.name });
      if (!updated) {
        throw new Error("画布更新失败");
      }
      await this.globalBus.publish({
        type: "kairo.workspace.canvas.updated",
        source: `agent:${context?.agentId || "default"}`,
        data: { canvasId: updated.id, canvasName: updated.name, op: "add_text", node },
        correlationId: context?.correlationId,
        causationId: context?.causationId,
        traceId: context?.traceId,
        spanId: context?.spanId,
      });
      return { status: "ok", canvasId: updated.id, canvasName: updated.name, node };
    });

    this.registerSystemTool({
      name: "kairo_canvas_add_image",
      description: "向前端画布添加图片节点",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "用户 ID" },
          projectId: { type: "string", description: "项目 ID" },
          canvasId: { type: "string", description: "画布 ID（可选）" },
          canvasName: { type: "string", description: "画布名称（未传 canvasId 时用于定位）" },
          createIfMissing: { type: "boolean", description: "未找到画布时是否自动创建" },
          title: { type: "string", description: "节点标题" },
          src: { type: "string", description: "图片 URL" },
          content: { type: "string", description: "附加描述" },
          x: { type: "number", description: "X 坐标" },
          y: { type: "number", description: "Y 坐标" },
          width: { type: "number", description: "宽度" },
          height: { type: "number", description: "高度" },
        },
        required: ["userId", "projectId", "src"],
      },
    }, async (args: any, context: any) => {
      const toolArgs = this.mergeCanvasToolArgs(args, context);
      const { userId, projectId } = await this.resolveCanvasScope(toolArgs);
      const src = this.requireString(args, "src");
      const target = await this.findCanvasForTool(toolArgs, userId, projectId, toolArgs?.createIfMissing === true);
      const snapshot = this.normalizeCanvasSnapshot(target.snapshot, target.name);
      const nodeId = `node-${crypto.randomUUID().slice(0, 8)}`;
      const node: WorkspaceCanvasNode = {
        id: nodeId,
        type: "image",
        x: this.optionalNumber(args, "x") ?? 180,
        y: this.optionalNumber(args, "y") ?? 180,
        width: this.optionalNumber(args, "width") ?? 480,
        height: this.optionalNumber(args, "height") ?? 320,
        title: this.optionalString(args, "title") || "图片",
        src,
        content: this.optionalString(args, "content"),
      };
      snapshot.nodes.push(node);
      const [updated] = await db
        .update(apiCanvases)
        .set({ snapshot: snapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(apiCanvases.id, target.id), eq(apiCanvases.userId, userId), eq(apiCanvases.projectId, projectId)))
        .returning({ id: apiCanvases.id, name: apiCanvases.name });
      if (!updated) {
        throw new Error("画布更新失败");
      }
      await this.globalBus.publish({
        type: "kairo.workspace.canvas.updated",
        source: `agent:${context?.agentId || "default"}`,
        data: { canvasId: updated.id, canvasName: updated.name, op: "add_image", node },
        correlationId: context?.correlationId,
        causationId: context?.causationId,
        traceId: context?.traceId,
        spanId: context?.spanId,
      });
      return { status: "ok", canvasId: updated.id, canvasName: updated.name, node };
    });

    this.registerSystemTool({
      name: "kairo_canvas_read",
      description: "读取前端画布内容（节点与会话信息）",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "用户 ID" },
          projectId: { type: "string", description: "项目 ID" },
          canvasId: { type: "string", description: "画布 ID（可选）" },
          canvasName: { type: "string", description: "画布名称（未传 canvasId 时用于定位）" },
        },
        required: ["userId", "projectId"],
      },
    }, async (args: any, context: any) => {
      const toolArgs = this.mergeCanvasToolArgs(args, context);
      const { userId, projectId } = await this.resolveCanvasScope(toolArgs);
      const target = await this.findCanvasForTool(toolArgs, userId, projectId, false);
      const snapshot = this.normalizeCanvasSnapshot(target.snapshot, target.name);
      return {
        canvasId: target.id,
        canvasName: target.name,
        sessionId: target.sessionId,
        updatedAt: target.updatedAt.toISOString(),
        nodeCount: snapshot.nodes.length,
        nodes: snapshot.nodes,
        messages: snapshot.messages,
        chatSessions: snapshot.chatSessions || [],
        scale: snapshot.scale,
        offset: snapshot.offset,
      };
    });
    
    // Subscribe to legacy messages and route to default
    this.globalBus.subscribe("kairo.legacy.*", async (event) => {
         const type = event.type.replace("kairo.legacy.", "");
         
         if (type === "user_message") {
             await this.globalBus.publish({
                type: `kairo.agent.default.message`,
                source: "orchestrator",
                data: { content: (event.data as any).text }
            });
         } else if (type === "system_event") {
              // Route system events to default agent as user message or special event?
              // AgentRuntime.mapEventToObservation handles 'user_message' or 'agent.ID.message'.
              // It maps them to { type: "user_message", ... }
              // If we want it to be a system event observation, we need a new event type or map it differently.
              // AgentRuntime.mapEventToObservation:
              // if (event.type === "kairo.user.message" || event.type === `kairo.agent.${this.id}.message`) -> user_message
              
              // We need a way to send system events.
              // Let's use `kairo.agent.default.message` with special content?
              // Or update AgentRuntime to listen to `kairo.agent.${this.id}.event`?
              
              // Simplest: Send as message for now, or update AgentRuntime.
              // Let's just log it for now as "System: ..."
              
              await this.globalBus.publish({
                type: `kairo.agent.default.message`,
                source: "orchestrator",
                data: { content: `[System Event] ${(event.data as any).name}: ${JSON.stringify((event.data as any).payload)}` }
            });
         }
    });
  }

  async stop() {
    console.log("[Agent] Stopping Agent domain...");
    for (const agent of this.agents.values()) {
        agent.stop();
    }
    this.agents.clear();
  }

  private spawnAgent(id: string, memory?: AgentMemory) {
      if (this.agents.has(id)) return this.agents.get(id)!;
      
      const agentMemory = memory || new InMemoryAgentMemory();
      if (this.memoryStore && agentMemory instanceof InMemoryAgentMemory) {
          agentMemory.setLongTermMemory(this.memoryStore);
      }

      const runtime = new AgentRuntime({
          id,
          ai: this.ai!,
          mcp: this.mcp,
          bus: this.globalBus,
          memory: agentMemory,
          sharedMemory: this.sharedMemory,
          vault: this.vault,
          onAction: (a) => this.actionListeners.forEach(l => l(a)),
          onLog: (l) => this.logListeners.forEach(l => l(l)),
          onActionResult: (r) => this.actionResultListeners.forEach(l => l(r)),
          systemTools: this.systemTools
      });
      
      this.agents.set(id, runtime);
      runtime.start();
      return runtime;
  }

  /**
   * 任务委派：将任务从父 Agent 发送给子 Agent
   */
  async delegateTask(parentId: string, childId: string, task: {
    description: string;
    input?: any;
    timeout?: number;
  }): Promise<string> {
    if (!this.agents.has(childId)) {
      this.spawnAgent(childId);
    }

    const taskId = crypto.randomUUID();

    await this.globalBus.publish({
      type: `kairo.agent.${childId}.task`,
      source: `agent:${parentId}`,
      data: {
        taskId,
        parentId,
        description: task.description,
        input: task.input,
        timeout: task.timeout || 30000,
      },
    });

    return taskId;
  }

  private requireString(args: any, key: string): string {
    const value = args?.[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`参数 ${key} 无效`);
    }
    return value.trim();
  }

  private optionalString(args: any, key: string): string | undefined {
    const value = args?.[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`参数 ${key} 无效`);
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private optionalNumber(args: any, key: string): number | undefined {
    const value = args?.[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`参数 ${key} 无效`);
    }
    return value;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private normalizeScopeId(value: string | undefined, key: "userId" | "projectId"): string | undefined {
    if (!value) return undefined;
    const lowered = value.toLowerCase();
    if (lowered === "default" || lowered === "auto" || lowered === "current") {
      return undefined;
    }
    if (!this.isUuid(value)) {
      throw new Error(`参数 ${key} 无效，需要 UUID，或传 default`);
    }
    return value;
  }

  private async resolveCanvasScope(args: any): Promise<{ userId: string; projectId: string }> {
    const rawUserId = this.optionalString(args, "userId");
    const rawProjectId = this.optionalString(args, "projectId");
    let userId = this.normalizeScopeId(rawUserId, "userId");
    let projectId = this.normalizeScopeId(rawProjectId, "projectId");
    if (userId && projectId) {
      return { userId, projectId };
    }

    await ensureCloudTables();
    const canvasId = this.optionalString(args, "canvasId");
    const canvasName = this.optionalString(args, "canvasName");

    if (canvasId) {
      if (!this.isUuid(canvasId)) {
        throw new Error("参数 canvasId 无效，需要 UUID");
      }
      const [match] = await db
        .select({
          userId: apiCanvases.userId,
          projectId: apiCanvases.projectId,
        })
        .from(apiCanvases)
        .where(eq(apiCanvases.id, canvasId))
        .limit(1);
      if (match) {
        userId = userId || match.userId;
        projectId = projectId || match.projectId;
      }
    }

    if ((!userId || !projectId) && canvasName) {
      const [match] = await db
        .select({
          userId: apiCanvases.userId,
          projectId: apiCanvases.projectId,
        })
        .from(apiCanvases)
        .where(eq(apiCanvases.name, canvasName))
        .orderBy(desc(apiCanvases.updatedAt))
        .limit(1);
      if (match) {
        userId = userId || match.userId;
        projectId = projectId || match.projectId;
      }
    }

    if (!userId || !projectId) {
      const [latest] = await db
        .select({
          userId: apiCanvases.userId,
          projectId: apiCanvases.projectId,
        })
        .from(apiCanvases)
        .orderBy(desc(apiCanvases.updatedAt))
        .limit(1);
      if (latest) {
        userId = userId || latest.userId;
        projectId = projectId || latest.projectId;
      }
    }

    if (!userId || !projectId) {
      throw new Error("无法推断 userId/projectId，请传入有效 UUID，或先创建画布后使用 default");
    }
    return { userId, projectId };
  }

  private normalizeCanvasSnapshot(snapshot: Record<string, unknown> | null | undefined, fallbackName: string): WorkspaceCanvasSnapshot {
    const base = snapshot && typeof snapshot === "object" ? snapshot : {};
    const nodes = Array.isArray((base as any).nodes) ? (base as any).nodes : [];
    const messages = Array.isArray((base as any).messages) ? (base as any).messages : [];
    const chatSessions = Array.isArray((base as any).chatSessions) ? (base as any).chatSessions : [];
    const rawScale = typeof (base as any).scale === "number" && Number.isFinite((base as any).scale) ? (base as any).scale : 1;
    const rawOffset = (base as any).offset && typeof (base as any).offset === "object" ? (base as any).offset : {};
    const offsetX = typeof rawOffset.x === "number" && Number.isFinite(rawOffset.x) ? rawOffset.x : 0;
    const offsetY = typeof rawOffset.y === "number" && Number.isFinite(rawOffset.y) ? rawOffset.y : 0;
    const canvasName = typeof (base as any).canvasName === "string" && (base as any).canvasName.trim().length > 0
      ? (base as any).canvasName.trim()
      : fallbackName;
    return {
      nodes: nodes as WorkspaceCanvasNode[],
      messages: messages as WorkspaceCanvasSnapshot["messages"],
      chatSessions: chatSessions as WorkspaceCanvasSnapshot["chatSessions"],
      scale: rawScale,
      offset: { x: offsetX, y: offsetY },
      canvasName,
    };
  }

  private async findCanvasForTool(args: any, userId: string, projectId: string, createIfMissing: boolean) {
    await ensureCloudTables();
    const canvasId = this.optionalString(args, "canvasId");
    const canvasName = this.optionalString(args, "canvasName");
    if (canvasId && !this.isUuid(canvasId)) {
      throw new Error("参数 canvasId 无效，需要 UUID");
    }
    const where =
      canvasId
        ? and(eq(apiCanvases.id, canvasId), eq(apiCanvases.userId, userId), eq(apiCanvases.projectId, projectId))
        : and(eq(apiCanvases.name, canvasName || "默认画布"), eq(apiCanvases.userId, userId), eq(apiCanvases.projectId, projectId));
    const [existing] = await db
      .select({
        id: apiCanvases.id,
        name: apiCanvases.name,
        sessionId: apiCanvases.sessionId,
        snapshot: apiCanvases.snapshot,
        updatedAt: apiCanvases.updatedAt,
      })
      .from(apiCanvases)
      .where(where)
      .limit(1);
    if (existing) {
      return existing;
    }
    if (!createIfMissing) {
      throw new Error("画布不存在");
    }
    const name = canvasName || "默认画布";
    const now = new Date();
    const [created] = await db
      .insert(apiCanvases)
      .values({
        userId,
        projectId,
        name,
        sessionId: `canvas-${Date.now()}`,
        snapshot: {
          nodes: [],
          messages: [],
          chatSessions: [],
          scale: 1,
          offset: { x: 0, y: 0 },
          canvasName: name,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: apiCanvases.id,
        name: apiCanvases.name,
        sessionId: apiCanvases.sessionId,
        snapshot: apiCanvases.snapshot,
        updatedAt: apiCanvases.updatedAt,
      });
    if (!created) {
      throw new Error("画布创建失败");
    }
    return created;
  }

  private extractFirstJsonObject(text: string): string | undefined {
    const start = text.indexOf("{");
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth++;
      if (char === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return undefined;
  }

  private parseRoutingRelevance(raw: string): boolean {
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const jsonCandidate = this.extractFirstJsonObject(cleaned);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate) as { relevant?: unknown };
        if (typeof parsed.relevant === "boolean") {
          return parsed.relevant;
        }
      } catch {}
    }
    const relevantMatch = cleaned.match(/"relevant"\s*:\s*(true|false)/i) ?? cleaned.match(/\brelevant\s*[:=]\s*(true|false)\b/i);
    if (relevantMatch) {
      return relevantMatch[1].toLowerCase() === "true";
    }
    throw new Error("Unable to parse routing relevance");
  }

  private async publishRoutedMessage(event: KairoEvent, agentId: string) {
    const payload = event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? { ...(event.data as Record<string, unknown>) }
      : {};
    if (typeof payload.content !== "string") {
      payload.content = "";
    }
    await this.globalBus.publish({
      type: `kairo.agent.${agentId}.message`,
      source: "orchestrator",
      data: payload,
      correlationId: event.correlationId,
      causationId: event.id,
      traceId: event.traceId,
      spanId: event.spanId,
    });
  }

  private async handleUserMessage(event: KairoEvent) {
        const content = (event.data as any).content;
        const target = (event.data as any).targetAgentId;
        
        if (target) {
            if (!this.agents.has(target)) {
                 // Auto-spawn if targeted explicitly?
                 this.spawnAgent(target);
            }
            await this.publishRoutedMessage(event, target);
            return;
        }
        
        // Semantic Routing: Check relevance to default agent
        // We only check default for now as it's the main context.
        const defaultAgent = this.agents.get("default");
        if (!defaultAgent) return; // Should not happen

        try {
            // Get a snippet of context (last 1000 chars)
            // Accessing private memory via 'any' or assuming getContext is public (it is)
            const context = this.memory.getContext(); 
            const recentContext = context.slice(-1000);

            const prompt = `You are a Router.
Current Conversation Context:
${recentContext}

New User Message: "${content}"

Is this message relevant to the current conversation?
Or is it a completely new, unrelated topic?
If it is unrelated, we should spawn a new agent.

Reply JSON: { "relevant": boolean }`;

            const response = await this.ai!.chat([{ role: "user", content: prompt }]);
            
            // Safe parse
            let relevant = true;
            try {
                relevant = this.parseRoutingRelevance(response.content);
            } catch (e) {
                console.warn("[Orchestrator] Failed to parse routing decision, defaulting to relevant.", e);
            }

            if (relevant) {
                 await this.publishRoutedMessage(event, "default");
            } else {
                const newId = crypto.randomUUID();
                console.log(`[Orchestrator] Spawning new agent ${newId} for unrelated task.`);
                this.spawnAgent(newId);
                await this.publishRoutedMessage(event, newId);
            }

        } catch (e) {
            console.error("[Orchestrator] Routing error:", e);
             // Fallback
             await this.publishRoutedMessage(event, "default");
        }
  }

  private mergeCanvasToolArgs(args: any, context: any) {
    const merged = args && typeof args === "object" ? { ...args } : {};
    const copyString = (key: "userId" | "projectId" | "canvasId" | "canvasName") => {
      const current = merged[key];
      if (typeof current === "string" && current.trim().length > 0) {
        return;
      }
      const fromContext = context?.[key];
      if (typeof fromContext === "string" && fromContext.trim().length > 0) {
        merged[key] = fromContext.trim();
      }
    };
    copyString("userId");
    copyString("projectId");
    copyString("canvasId");
    copyString("canvasName");
    return merged;
  }
}
