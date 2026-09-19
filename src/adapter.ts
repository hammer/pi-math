import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import type { Worker, WorkerRequest, WorkerResponse } from "./inference.ts";
import { generationFor, type Config, type Generation } from "./schema.ts";

export type WorkerContext = Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">;
type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const SAMPLING = new Set(["temperature", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "seed"]);
const OPENAI_APIS = ["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses"];
const LEVELS: Effort[] = ["high", "medium", "low", "xhigh", "max", "minimal"];

export function isLoopback(baseUrl: string): boolean {
    try {
        const u = new URL(baseUrl);
        return ["http:", "https:"].includes(u.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
            && !u.username && !u.password && !u.search && !u.hash;
    } catch { return false; }
}
export function selectWorkerModel(ctx: WorkerContext, config: Config, role: string): Model<Api> {
    const [stage, suffix] = role.split("/");
    const chosen = config.models[role] ?? config.models[suffix ?? ""] ?? config.models[stage!] ?? config.models.default;
    const model = chosen ? ctx.modelRegistry.find(chosen.provider, chosen.id) : ctx.model;
    if (!model) throw new Error("No research model available. Use /math setup or select a Pi model with /model; check the exact provider/model ID.");
    if (ctx.scopedModels.length && !ctx.scopedModels.some(s => s.model.id === model.id && s.model.provider === model.provider))
        throw new Error("Research model is outside the session's scoped models. Add it to the scope or change /math config.");
    if (config.localOnly && (model.api !== "openai-completions" || !isLoopback(model.baseUrl)))
        throw new Error("Local-only workers require an OpenAI-compatible loopback server. A remote model or fallback was refused.");
    for (const [key, value] of Object.entries(model.samplingParams ?? {})) {
        if (!SAMPLING.has(key) || typeof value !== "number" || !Number.isFinite(value))
            throw new Error(`Unsupported model samplingParams key/value: ${key}. Use pi-math generation settings; payload overrides can defeat worker budgets.`);
    }
    return model;
}
export function resolveReasoning(model: Model<Api>, g: Generation): Effort | "off" | "default" | number {
    const requested = g.reasoning ?? "auto";
    if (requested === "default") return "default";
    if (!model.reasoning) {
        if (!["auto", "off"].includes(String(requested))) throw new Error("Selected model does not declare reasoning support. If you recently corrected this model's metadata, reselect it in /model or restart Pi so the session uses the updated entry.");
        return "off";
    }
    if (typeof requested === "number") {
        if (model.api !== "openai-completions" || (model as Model<"openai-completions">).compat?.thinkingFormat !== "deepseek" || !/v4[.-]1/i.test(model.id))
            throw new Error("Numeric effort is supported only for native DeepSeek V4.1-compatible entries; use the gateway's supported effort labels otherwise.");
        return requested;
    }
    const effort = requested === "auto" ? LEVELS.find(l => model.thinkingLevelMap?.[l] !== null) : requested;
    if (!effort || model.thinkingLevelMap?.[effort] === null)
        throw new Error(`Reasoning setting ${requested} is unsupported by this model. Inspect its supported levels in Pi.`);
    if (effort === "off" && model.api === "openai-completions") {
        const format = (model as Model<"openai-completions">).compat?.thinkingFormat;
        if (!format || format === "openai") {
            if (typeof model.thinkingLevelMap?.off !== "string") throw new Error("This model does not declare an explicit off mapping. Use provider defaults or configure a supported off value.");
        }
    }
    if (effort === "off" && model.api !== "openai-completions") throw new Error("Explicit off control currently requires a declared OpenAI-completions mapping. Use provider defaults for this API.");
    return effort;
}
/** Deliberately conservative byte-based estimate, not a model tokenizer. */
export function estimateInputTokens(system: string, prompt: string): number {
    return Buffer.byteLength(system, "utf8") + Buffer.byteLength(prompt, "utf8") + 256;
}
export function workerSettings(ctx: WorkerContext, config: Config, role: string) {
    const model = selectWorkerModel(ctx, config, role), generation = generationFor(config, role);
    const reasoning = !OPENAI_APIS.includes(model.api) && ["auto", "default"].includes(String(generation.reasoning ?? "auto")) ? "default" : resolveReasoning(model, generation);
    const contextWindow = Math.min(model.contextWindow || Infinity, generation.contextWindow ?? Infinity);
    const maxOutputTokens = generation.maxOutputTokens ?? config.maxOutputTokens;
    if (model.maxTokens && maxOutputTokens > model.maxTokens)
        throw new Error(`Output limit ${maxOutputTokens} exceeds ${model.id}'s declared limit ${model.maxTokens}. Lower maxOutputTokens.`);
    if (maxOutputTokens >= contextWindow) throw new Error("Output budget leaves no space for input. Increase the actual server context or lower the output budget.");
    if (generation.thinkingBudget !== undefined && generation.thinkingBudget + (generation.finalAnswerReserve ?? 1024) > maxOutputTokens)
        throw new Error("Thinking budget leaves too little room for the final JSON answer. Increase the combined output cap or lower thinkingBudget.");
    if (generation.thinkingBudget !== undefined && ["off", "default"].includes(String(reasoning)))
        throw new Error("An explicit thinkingBudget requires reasoning to be enabled.");
    if (generation.thinkingBudget !== undefined) {
        const compat = (model as Model<"openai-completions">).compat;
        if (model.api !== "openai-completions" || !(compat?.thinkingTokenBudgetField || compat?.supportsThinkingTokenBudget))
            throw new Error("No verified thinking-budget field is declared for this model/server. Use an effort level instead.");
    }
    if (generation.structuredOutput === "json-schema" && model.api !== "openai-completions")
        throw new Error("Native JSON Schema mode currently requires openai-completions. Use prompt mode for other Pi APIs.");
    const openAI = OPENAI_APIS.includes(model.api);
    if (!openAI && generation.reasoning !== undefined && !["auto", "default"].includes(String(generation.reasoning)))
        throw new Error("Explicit reasoning controls currently support OpenAI-compatible Pi APIs. Select a supported preset or use provider defaults.");
    const sampling = [generation.temperature, generation.topP, generation.topK, generation.minP].some(v => v !== undefined) || Object.keys(model.samplingParams ?? {}).length > 0;
    if (!openAI && (sampling || generation.thinkingBudget !== undefined)) throw new Error("Sampling/thinking-budget overrides currently require an OpenAI-compatible API.");
    if (model.provider === "moonshotai" && model.id === "kimi-k3" && sampling) throw new Error("Kimi K3's direct API fixes sampling parameters; omit sampling overrides.");
    return { model, generation, reasoning, contextWindow, maxOutputTokens };
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a provider request object");
    return value as Record<string, unknown>;
}

/** Uses Pi's authenticated registry; never creates another credential store. */
export class PiWorker implements Worker {
    constructor(readonly ctx: WorkerContext, readonly config: Config, private fetchImpl: typeof fetch = globalThis.fetch) { }
    async complete(request: WorkerRequest): Promise<WorkerResponse> {
        const { model, generation: g, reasoning, contextWindow } = workerSettings(this.ctx, this.config, request.role);
        const inputEstimate = estimateInputTokens(request.system, request.prompt);
        if (inputEstimate + request.maxOutputTokens > contextWindow)
            throw new Error(`Conservative input estimate (${inputEstimate}) plus output (${request.maxOutputTokens}) exceeds context (${contextWindow}). Narrow the task or configure a larger actual server context.`);
        if (model.maxTokens && request.maxOutputTokens > model.maxTokens) throw new Error("Reserved output exceeds model limit");
        const openAI = OPENAI_APIS.includes(model.api);
        const sampling: Record<string, number> = { ...model.samplingParams } as Record<string, number>;
        for (const [key, value] of Object.entries({ temperature: g.temperature, top_p: g.topP, top_k: g.topK, min_p: g.minP }))
            if (value !== undefined) sampling[key] = value;
        const options: ModelsApiStreamOptions<Api> = {
            signal: request.signal, maxTokens: request.maxOutputTokens, maxRetries: 0, timeoutMs: this.config.timeoutMs,
            ...(openAI && typeof reasoning === "string" && LEVELS.includes(reasoning as Effort) ? { reasoningEffort: reasoning as Effort } : {}),
            ...(Object.keys(sampling).length ? { samplingParams: sampling } : {}),
        };
        const guard = (value: unknown) => {
            const p = object(value);
            if (p.model !== model.id) throw new Error("Provider payload changed the selected worker model");
            if ((p.tools !== undefined && (!Array.isArray(p.tools) || p.tools.length)) || p.functions !== undefined)
                throw new Error("Tools are not allowed in isolated research workers");
            const caps = [p.max_tokens, p.max_completion_tokens, p.max_output_tokens].filter(v => v !== undefined);
            if (caps.length !== 1 || caps[0] !== request.maxOutputTokens)
                throw new Error("Provider payload changed the reserved output budget");
            if (p.n !== undefined && p.n !== 1) throw new Error("Multiple completions would bypass call reservations");
            return p;
        };
        if (openAI) {
            options.onPayload = (payload) => {
                const p = guard(payload);
                if (reasoning === "default") {
                    for (const key of ["reasoning", "reasoning_effort", "thinking", "enable_thinking"]) delete p[key];
                    if (p.chat_template_kwargs) {
                        const kwargs = { ...object(p.chat_template_kwargs) };
                        delete kwargs.enable_thinking; delete kwargs.reasoning_effort;
                        p.chat_template_kwargs = kwargs;
                    }
                }
                if (typeof reasoning === "number") { p.thinking = { type: "enabled" }; p.reasoning_effort = reasoning; }
                if (g.thinkingBudget !== undefined) {
                    if (model.api !== "openai-completions") throw new Error("Thinking token budgets currently require openai-completions");
                    const compat = (model as Model<"openai-completions">).compat;
                    const field = compat?.thinkingTokenBudgetField ?? (compat?.supportsThinkingTokenBudget ? "thinking_token_budget" : undefined);
                    if (!field) throw new Error("No verified thinking-budget field is declared for this model/server. Use an effort level instead.");
                    if (field === "thinking_budget" && p.reasoning_effort !== undefined)
                        throw new Error("This budget field can conflict with reasoning_effort (including on DashScope). Use an effort level without thinkingBudget.");
                    if (g.thinkingBudget + (g.finalAnswerReserve ?? 1024) > request.maxOutputTokens) throw new Error("Thinking budget exceeds this call's reservation");
                    p[field] = g.thinkingBudget;
                }
                if (g.structuredOutput === "json-schema") {
                    if (!request.jsonSchema) throw new Error("Worker schema was not supplied");
                    const { $schema: _dialect, ...schema } = request.jsonSchema;
                    p.response_format = { type: "json_schema", json_schema: { name: "math_response", strict: true, schema } };
                }
                return p;
            };
            // Inspect the serialized request too, after provider hooks/auth transforms.
            options.fetch = async (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input));
                if (this.config.localOnly && (!isLoopback(url.origin) || url.origin !== new URL(model.baseUrl).origin))
                    throw new Error("Local-only transport refused a different endpoint");
                const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
                if (typeof body !== "string") throw new Error("Cannot verify the serialized worker request");
                guard(JSON.parse(body));
                return this.fetchImpl(input, { ...init, redirect: "error" });
            };
        }
        const response = await this.ctx.modelRegistry.complete(model, {
            systemPrompt: request.system,
            messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }], tools: [],
        }, options);
        if (response.stopReason !== "stop")
            throw new Error(`Research worker ended with ${response.stopReason}. ${response.stopReason === "length" ? "Reasoning may have consumed the output budget; increase the combined cap or reduce effort." : "Run /math doctor and check server/auth/model compatibility."}`);
        if (response.content.some(c => c.type === "toolCall")) throw new Error("Tool calls are not allowed in isolated research workers");
        const text = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
        if (!text.trim()) throw new Error("The model returned no final answer. Check reasoning/output limits and the server's reasoning parser.");
        return { text, model: `${response.provider}/${response.model}`,
            settings: { requestedModel: `${model.provider}/${model.id}`, endpointOrigin: model.baseUrl ? new URL(model.baseUrl).origin : null, reasoning, generation: g, maxOutputTokens: request.maxOutputTokens, inputEstimate, inputEstimation: "utf8-bytes-plus-256", contextWindow: Number.isFinite(contextWindow) ? contextWindow : null, localOnly: this.config.localOnly, sampling, structuredOutput: g.structuredOutput ?? "prompt" },
            usage: { input: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite, output: response.usage.output, cost: response.usage.cost.total } };
    }
}
