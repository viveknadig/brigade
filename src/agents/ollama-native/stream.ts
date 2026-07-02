// Native Ollama transport — talks to Ollama's own /api/chat endpoint instead of
// the OpenAI-compatible /v1 shim. The native endpoint runs the model's tool-aware
// chat template server-side and returns STRUCTURED `tool_calls` (plus native
// `thinking`), which the /v1 shim does not reliably do for local models. This is
// the same approach OpenClaw takes; the streaming/event contract is identical
// across the Pi versions, so the producer maps 1:1 onto pi-ai's
// `AssistantMessageEventStream`.
//
// Shape: `createOllamaStreamFn(baseUrl)` returns a Pi `StreamFn`
// `(model, context, options) => AssistantMessageEventStream`. It returns the
// stream synchronously and fills it from an async producer, exactly as pi-ai's
// built-in providers do.

import { randomUUID } from "node:crypto";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
	parseJsonObjectPreservingUnsafeIntegers,
	parseJsonPreservingUnsafeIntegers,
} from "./ollama-json.js";

export const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_NUM_CTX = 65536;

/* ─────────────────────────── wire types ─────────────────────────── */

interface OllamaChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: string[];
	tool_calls?: OllamaWireToolCall[];
	tool_name?: string;
}

interface OllamaWireToolCall {
	function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaWireTool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OllamaChatRequest {
	model: string;
	messages: OllamaChatMessage[];
	stream: boolean;
	tools?: OllamaWireTool[];
	options?: Record<string, unknown>;
	think?: boolean;
}

interface OllamaChatResponse {
	model?: string;
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		reasoning?: string;
		tool_calls?: OllamaWireToolCall[];
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
}

interface ModelDescriptor {
	api: string;
	provider: string;
	id: string;
}

/* ─────────────────────────── url + id normalization ─────────────────────────── */

/** Strip trailing slashes and a trailing `/v1`, then append `/api/chat`. */
export function resolveOllamaChatUrl(baseUrl: string): string {
	const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
	const base = trimmed.replace(/\/v1$/i, "");
	return `${base || OLLAMA_NATIVE_BASE_URL}/api/chat`;
}

/** Drop a leading `ollama/` provider prefix from the wire model id. */
function normalizeWireModelId(modelId: string): string {
	const trimmed = (modelId ?? "").trim();
	return trimmed.startsWith("ollama/") ? trimmed.slice("ollama/".length) : trimmed;
}

/* ─────────────────────────── request conversion ─────────────────────────── */

type InputContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string }
	| { type: "toolCall"; id?: string; name: string; arguments: unknown }
	| { type: "tool_use"; id?: string; name: string; input: unknown };

function ensureArgsObject(value: unknown): Record<string, unknown> {
	return parseJsonObjectPreservingUnsafeIntegers(value) ?? {};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as InputContentPart[])
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
}

function extractImages(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return (content as InputContentPart[])
		.filter((p): p is { type: "image"; data: string } => p?.type === "image" && typeof p.data === "string")
		.map((p) => p.data);
}

function extractWireToolCalls(content: unknown): OllamaWireToolCall[] {
	if (!Array.isArray(content)) return [];
	const out: OllamaWireToolCall[] = [];
	for (const part of content as InputContentPart[]) {
		if (part?.type === "toolCall") {
			out.push({ function: { name: part.name, arguments: ensureArgsObject(part.arguments) } });
		} else if (part?.type === "tool_use") {
			out.push({ function: { name: part.name, arguments: ensureArgsObject(part.input) } });
		}
	}
	return out;
}

/** Convert Pi's message array + system prompt into Ollama chat messages. */
export function convertToOllamaMessages(
	messages: Array<{ role: string; content: unknown; toolName?: unknown }>,
	systemPrompt?: string,
): OllamaChatMessage[] {
	const out: OllamaChatMessage[] = [];
	if (systemPrompt) out.push({ role: "system", content: systemPrompt });

	for (const msg of messages) {
		if (msg.role === "user") {
			const images = extractImages(msg.content);
			out.push({
				role: "user",
				content: extractTextContent(msg.content),
				...(images.length > 0 ? { images } : {}),
			});
			continue;
		}
		if (msg.role === "assistant") {
			const toolCalls = extractWireToolCalls(msg.content);
			out.push({
				role: "assistant",
				content: extractTextContent(msg.content),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			continue;
		}
		if (msg.role === "tool" || msg.role === "toolResult") {
			const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
			out.push({
				role: "tool",
				content: extractTextContent(msg.content),
				...(toolName ? { tool_name: toolName } : {}),
			});
		}
	}
	return out;
}

/** Map Pi `Tool[]` to Ollama's function-tool wire shape (schema passed through). */
export function extractOllamaTools(tools: Tool[] | undefined): OllamaWireTool[] {
	if (!Array.isArray(tools)) return [];
	const out: OllamaWireTool[] = [];
	for (const tool of tools) {
		if (typeof tool?.name !== "string" || !tool.name) continue;
		out.push({
			type: "function",
			function: {
				name: tool.name,
				description: typeof tool.description === "string" ? tool.description : "",
				parameters: ((tool as { parameters?: unknown }).parameters ?? {}) as Record<string, unknown>,
			},
		});
	}
	return out;
}

function buildOllamaChatRequest(params: {
	modelId: string;
	messages: OllamaChatMessage[];
	tools?: OllamaWireTool[];
	options?: Record<string, unknown>;
	think?: boolean;
}): OllamaChatRequest {
	return {
		model: normalizeWireModelId(params.modelId),
		messages: params.messages,
		stream: true,
		...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
		...(params.options ? { options: params.options } : {}),
		...(params.think !== undefined ? { think: params.think } : {}),
	};
}

/* ─────────────────────────── message + usage builders ─────────────────────────── */

function buildUsageWithNoCost(params: { input?: number; output?: number }): Usage {
	const input = params.input ?? 0;
	const output = params.output ?? 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

function buildAssistantMessageShell(params: {
	model: ModelDescriptor;
	content: (TextContent | ThinkingContent | ToolCall)[];
	stopReason: StopReason;
	usage: Usage;
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: params.content,
		api: params.model.api,
		provider: params.model.provider,
		model: params.model.id,
		usage: params.usage,
		stopReason: params.stopReason,
		...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
		timestamp: Date.now(),
	} as AssistantMessage;
}

/* ─────────────────────────── NDJSON reader ─────────────────────────── */

/** Line-buffered NDJSON reader. Skips blank/malformed lines (never fatal). */
export async function* parseNdjsonStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OllamaChatResponse> {
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				yield parseJsonPreservingUnsafeIntegers(trimmed) as OllamaChatResponse;
			} catch {
				/* skip malformed line */
			}
		}
	}
	if (buffer.trim()) {
		try {
			yield parseJsonPreservingUnsafeIntegers(buffer.trim()) as OllamaChatResponse;
		} catch {
			/* skip malformed trailing data */
		}
	}
}

/* ─────────────────────────── the stream fn ─────────────────────────── */

/** Derive Ollama's native `think` flag from Pi's thinking level. Off/unset →
 *  omit (tools stay reliable on local models); any explicit non-off → true. */
function resolveThink(reasoning: unknown): boolean | undefined {
	if (typeof reasoning !== "string") return undefined;
	if (reasoning === "off") return false;
	return true;
}

/**
 * Build a Pi `StreamFn` that streams a turn against Ollama's native /api/chat.
 * The chat URL is resolved from the MODEL's baseUrl per call (so one registered
 * transport serves every Ollama endpoint — local or remote). `defaultHeaders`
 * merge under per-call `options.headers`.
 */
export function createOllamaStreamFn(defaultHeaders?: Record<string, string>): StreamFn {
	return ((model: Model<string>, context: unknown, options: Record<string, unknown> | undefined) => {
		const chatUrl = resolveOllamaChatUrl((model as { baseUrl?: string }).baseUrl ?? OLLAMA_NATIVE_BASE_URL);
		const stream = createAssistantMessageEventStream();
		const modelInfo: ModelDescriptor = { api: model.api, provider: model.provider, id: model.id };

		const run = async (): Promise<void> => {
			// accumulators
			let accumulatedThinking = "";
			let accumulatedContent = "";
			const accumulatedToolCalls: OllamaWireToolCall[] = [];
			let finalResponse: OllamaChatResponse | undefined;
			// event-ordering flags
			let started = false;
			let thinkingStarted = false;
			let thinkingEnded = false;
			let textStarted = false;
			let textClosed = false;
			const textIndex = () => (thinkingStarted ? 1 : 0);

			const currentContent = (): (TextContent | ThinkingContent | ToolCall)[] => {
				const parts: (TextContent | ThinkingContent | ToolCall)[] = [];
				if (accumulatedThinking) parts.push({ type: "thinking", thinking: accumulatedThinking } as ThinkingContent);
				if (accumulatedContent) parts.push({ type: "text", text: accumulatedContent } as TextContent);
				return parts;
			};
			const partial = (): AssistantMessage =>
				buildAssistantMessageShell({
					model: modelInfo,
					content: currentContent(),
					stopReason: "stop",
					usage: buildUsageWithNoCost({}),
				});
			const ensureStarted = () => {
				if (started) return;
				started = true;
				stream.push({
					type: "start",
					partial: buildAssistantMessageShell({
						model: modelInfo,
						content: [],
						stopReason: "stop",
						usage: buildUsageWithNoCost({}),
					}),
				});
			};
			const closeThinking = () => {
				if (!thinkingStarted || thinkingEnded) return;
				thinkingEnded = true;
				stream.push({ type: "thinking_end", contentIndex: 0, content: accumulatedThinking, partial: partial() });
			};
			const closeText = () => {
				if (!textStarted || textClosed) return;
				textClosed = true;
				stream.push({ type: "text_end", contentIndex: textIndex(), content: accumulatedContent, partial: partial() });
			};

			try {
				const ctx = (context ?? {}) as {
					systemPrompt?: string;
					messages?: Array<{ role: string; content: unknown; toolName?: unknown }>;
					tools?: Tool[];
				};
				const ollamaMessages = convertToOllamaMessages(ctx.messages ?? [], ctx.systemPrompt);
				const ollamaTools = extractOllamaTools(ctx.tools);

				const ollamaOptions: Record<string, unknown> = {
					num_ctx: typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : DEFAULT_NUM_CTX,
				};
				if (typeof options?.temperature === "number") ollamaOptions.temperature = options.temperature;
				if (typeof options?.maxTokens === "number") ollamaOptions.num_predict = options.maxTokens;

				const body = buildOllamaChatRequest({
					modelId: model.id,
					messages: ollamaMessages,
					tools: ollamaTools,
					options: ollamaOptions,
					think: resolveThink(options?.reasoning),
				});
				if (typeof options?.onPayload === "function") {
					await (options.onPayload as (p: unknown, m: unknown) => unknown)(body, model);
				}

				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					...defaultHeaders,
					...((options?.headers as Record<string, string> | undefined) ?? {}),
				};
				const apiKey = options?.apiKey;
				if (typeof apiKey === "string" && apiKey && !headers.Authorization) {
					headers.Authorization = `Bearer ${apiKey}`;
				}

				const response = await fetch(chatUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: options?.signal as AbortSignal | undefined,
				});
				if (!response.ok || !response.body) {
					const detail = await response.text().catch(() => "");
					throw new Error(`Ollama /api/chat returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
				}

				const reader = response.body.getReader();
				for await (const chunk of parseNdjsonStream(reader)) {
					const thinkingDelta = chunk.message?.thinking ?? chunk.message?.reasoning;
					if (thinkingDelta) {
						ensureStarted();
						if (!thinkingStarted) {
							thinkingStarted = true;
							stream.push({ type: "thinking_start", contentIndex: 0, partial: partial() });
						}
						accumulatedThinking += thinkingDelta;
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinkingDelta, partial: partial() });
					}

					const contentDelta = chunk.message?.content;
					if (contentDelta) {
						if (thinkingStarted && !thinkingEnded) closeThinking();
						ensureStarted();
						if (!textStarted) {
							textStarted = true;
							stream.push({ type: "text_start", contentIndex: textIndex(), partial: partial() });
						}
						accumulatedContent += contentDelta;
						stream.push({ type: "text_delta", contentIndex: textIndex(), delta: contentDelta, partial: partial() });
					}

					if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
						closeThinking();
						closeText();
						accumulatedToolCalls.push(...chunk.message.tool_calls);
					}

					if (chunk.done) {
						finalResponse = chunk;
						break;
					}
				}

				closeThinking();
				closeText();

				const content: (TextContent | ThinkingContent | ToolCall)[] = [];
				if (accumulatedThinking) content.push({ type: "thinking", thinking: accumulatedThinking } as ThinkingContent);
				if (accumulatedContent) content.push({ type: "text", text: accumulatedContent } as TextContent);
				for (const tc of accumulatedToolCalls) {
					content.push({
						type: "toolCall",
						id: `ollama_call_${randomUUID()}`,
						name: tc.function.name,
						arguments: ensureArgsObject(tc.function.arguments),
					} as ToolCall);
				}

				const hasToolCalls = accumulatedToolCalls.length > 0;
				const message = buildAssistantMessageShell({
					model: modelInfo,
					content,
					stopReason: hasToolCalls ? "toolUse" : "stop",
					usage: buildUsageWithNoCost({
						input: finalResponse?.prompt_eval_count ?? 0,
						output: finalResponse?.eval_count ?? 0,
					}),
				});
				stream.push({ type: "done", reason: hasToolCalls ? "toolUse" : "stop", message });
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(errorMessage));
				stream.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: buildAssistantMessageShell({
						model: modelInfo,
						content: accumulatedContent ? [{ type: "text", text: accumulatedContent } as TextContent] : [],
						stopReason: aborted ? "aborted" : "error",
						usage: buildUsageWithNoCost({}),
						errorMessage,
					}),
				});
			} finally {
				stream.end();
			}
		};

		queueMicrotask(() => void run());
		return stream as AssistantMessageEventStream;
	}) as unknown as StreamFn;
}
