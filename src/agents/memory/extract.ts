/**
 * Post-turn memory extraction — Boop's extraction *algorithm*, run OpenClaw-
 * style OFF the hot path.
 *
 * Design rationale (scalable / enterprise): Boop runs an extraction LLM call
 * after EVERY turn (≈2× model calls/turn, cost grows with volume). OpenClaw
 * keeps the per-turn path at one call and does the expensive distillation in a
 * scheduled, batched sweep. We take OpenClaw's shape: a debounced background
 * sweep (driven by the long-lived gateway) reads the NEW transcript turns
 * since a cursor, distills them in ONE extraction call (many turns → one
 * call), stores the resulting structured facts, and advances the cursor.
 *
 * This module is the engine + cursor. The LLM call is INJECTED
 * (`ExtractionLlm`) so the distillation logic is unit-testable without a
 * provider; production builds the injectable via `makeExtractionLlm` (an
 * isolated, tool-less, throwaway-transcript subagent). The gateway wires the
 * debounced trigger (see server.ts).
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { pickInitialThinkingLevel } from "../../core/model-caps.js";
import { applyPersonaOverrideToSession } from "../../system-prompt/pi-injection.js";
import { FactStore, MEMORY_SEGMENTS, type MemorySegment } from "./records.js";

const log = createSubsystemLogger("memory/extract");

/** Cursor store — tracks how many transcript messages we've already distilled. */
const CURSOR_RELATIVE_PATH = path.join("memory", ".dreams", "extract-cursor.json");

/** Boop's extraction prompt, adapted to distill a BATCH of recent turns. */
export const EXTRACTION_PROMPT = `You are a memory-extraction subagent for a personal AI assistant.
You are given a slice of recent conversation (one or more USER/ASSISTANT turns).
Extract any DURABLE facts about the user or their world that are worth remembering long-term.

Return STRICT JSON only — no prose, no markdown fences:
{"facts":[{"content":"one clear self-contained sentence","segment":"identity|preference|correction|relationship|project|knowledge|context","importance":0.0,"corrects":"the prior belief, ONLY if segment=correction"}]}

Rules:
- Prefer few, high-quality facts over many trivial ones. Deduplicate within your output.
- Skip anything transient ("I'm tired right now"). Context facts describe ongoing state, not momentary feelings.
- Skip facts about YOU (the assistant) or the mechanics of the conversation.
- Segments: identity = who the user is; preference = how they like things done; correction = the user FIXED a prior belief (set "corrects"); relationship = people in their life; project = their work / conventions / goals; knowledge = durable facts they told you; context = ongoing situational state.
- Use "correction" (not preference/identity) when the user is fixing something rather than stating it fresh. "corrects" is ONLY for segment=correction.
- Importance defaults by segment: identity 0.85, correction 0.80, relationship 0.75, preference 0.70, project 0.65, knowledge 0.60, context 0.40. Trust the defaults unless something is unusually important or trivial.
- Return {"facts":[]} if nothing durable.
Respond with ONLY the JSON object.`;

export interface ExtractedFact {
	content: string;
	segment: string;
	importance?: number;
	corrects?: string;
}

/**
 * Parse the extraction model's reply into facts. Robust to prose-wrapped JSON
 * (grabs the first {...} block, like Boop's `/\{[\s\S]*\}/`). Never throws.
 */
export function parseExtractedFacts(text: string): ExtractedFact[] {
	if (!text) return [];
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return [];
	let parsed: { facts?: unknown };
	try {
		parsed = JSON.parse(match[0]) as { facts?: unknown };
	} catch {
		return [];
	}
	if (!Array.isArray(parsed.facts)) return [];
	const out: ExtractedFact[] = [];
	for (const raw of parsed.facts) {
		if (!raw || typeof raw !== "object") continue;
		const f = raw as Record<string, unknown>;
		if (typeof f.content !== "string" || f.content.trim().length === 0) continue;
		if (typeof f.segment !== "string") continue;
		out.push({
			content: f.content.trim(),
			segment: f.segment,
			importance: typeof f.importance === "number" ? f.importance : undefined,
			corrects: typeof f.corrects === "string" ? f.corrects : undefined,
		});
	}
	return out;
}

/**
 * Persist parsed facts to the FactStore. Skips unknown segments (rather than
 * crashing), clamps importance via the store, and stamps `corrects` into
 * metadata. Returns the number actually stored.
 */
export function storeExtractedFacts(
	workspaceDir: string,
	facts: ExtractedFact[],
	sourceTurn?: string,
): number {
	if (facts.length === 0) return 0;
	const store = new FactStore(workspaceDir);
	let stored = 0;
	for (const f of facts) {
		if (!MEMORY_SEGMENTS.includes(f.segment as MemorySegment)) continue;
		store.write({
			content: f.content,
			segment: f.segment as MemorySegment,
			...(f.importance !== undefined ? { importance: f.importance } : {}),
			...(sourceTurn ? { sourceTurn } : {}),
			// `corrects` only belongs on a correction (Boop gates it the same way);
			// a misbehaving model could attach it to any segment.
			...(f.corrects && f.segment === "correction" ? { metadata: { corrects: f.corrects } } : {}),
		});
		stored += 1;
	}
	return stored;
}

/* ───────────────────────── cursor ───────────────────────── */

interface CursorFile {
	version: 1;
	/** sessionId → number of messages already distilled. */
	cursors: Record<string, number>;
}

function cursorPath(workspaceDir: string): string {
	return path.join(workspaceDir, CURSOR_RELATIVE_PATH);
}

function readCursors(workspaceDir: string): CursorFile {
	try {
		const parsed = JSON.parse(fs.readFileSync(cursorPath(workspaceDir), "utf8")) as CursorFile;
		if (parsed && typeof parsed === "object" && parsed.cursors) return parsed;
	} catch {
		/* missing / corrupt → fresh */
	}
	return { version: 1, cursors: {} };
}

function writeCursor(workspaceDir: string, sessionId: string, processedCount: number): void {
	const file = readCursors(workspaceDir);
	file.cursors[sessionId] = processedCount;
	const p = cursorPath(workspaceDir);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(file), "utf8");
	fs.renameSync(tmp, p);
}

export function getCursor(workspaceDir: string, sessionId: string): number {
	return readCursors(workspaceDir).cursors[sessionId] ?? 0;
}

/* ───────────────────────── sweep ───────────────────────── */

/** Injectable distiller: given flattened conversation text, return the raw model reply. */
export type ExtractionLlm = (conversationText: string) => Promise<string>;

export interface SweepArgs {
	workspaceDir: string;
	sessionId: string;
	/** The full session message array (Pi `session.messages`). */
	messages: unknown[];
	/** The distiller (production: makeExtractionLlm; tests: a stub). */
	llm: ExtractionLlm;
	/** Minimum NEW messages since the cursor before a sweep runs. Default 2. */
	minNewMessages?: number;
}

export interface SweepResult {
	ran: boolean;
	stored: number;
	processedTo: number;
}

/**
 * Distill the NEW transcript messages since this session's cursor into facts.
 * Batches everything new into one LLM call, stores the result, advances the
 * cursor. No-op (without an LLM call) when there's too little new content.
 */
export async function runExtractionSweep(args: SweepArgs): Promise<SweepResult> {
	const total = args.messages.length;
	const from = Math.min(getCursor(args.workspaceDir, args.sessionId), total);
	const fresh = args.messages.slice(from);
	const minNew = args.minNewMessages ?? 2;
	const conversation = flattenConversation(fresh);
	// Need at least one real exchange worth of text.
	if (fresh.length < minNew || conversation.trim().length === 0) {
		return { ran: false, stored: 0, processedTo: from };
	}
	let reply = "";
	try {
		reply = await args.llm(conversation);
	} catch (err) {
		log.warn("extraction llm failed; cursor not advanced", {
			sessionId: args.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ran: false, stored: 0, processedTo: from };
	}
	const facts = parseExtractedFacts(reply);
	const stored = storeExtractedFacts(args.workspaceDir, facts, args.sessionId);
	// Advance the cursor past everything we just considered (even if 0 stored —
	// re-distilling the same turns would only waste calls).
	writeCursor(args.workspaceDir, args.sessionId, total);
	log.info("extraction sweep", {
		sessionId: args.sessionId,
		newMessages: fresh.length,
		candidates: facts.length,
		stored,
	});
	return { ran: true, stored, processedTo: total };
}

/** Flatten Pi messages into "USER: …\n\nASSISTANT: …" text for the distiller. */
export function flattenConversation(messages: unknown[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as { role?: string; content?: unknown };
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = flattenContent(msg.content).trim();
		if (!text) continue;
		lines.push(`${msg.role === "user" ? "USER" : "ASSISTANT"}: ${text}`);
	}
	return lines.join("\n\n");
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block && typeof block === "object") {
			const b = block as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("");
}

/* ───────────────────────── production distiller ───────────────────────── */

export interface MakeExtractionLlmArgs {
	workspaceDir: string;
	agentDir: string;
	authStorage: unknown;
	modelRegistry: unknown;
	model: unknown;
}

/**
 * Build an ISOLATED, tool-less subagent runner: a one-shot LLM call with
 * `systemPrompt` pinned, run against a throwaway transcript (deleted after) so
 * it never pollutes the real session. Reuses the resolved model/auth (inherits
 * Pi's auth-aware streamFn — never replaced). Shared by the extraction sweep
 * and the consolidation sweep; both cost one extra call per SWEEP, not per turn.
 */
export function makeIsolatedLlm(
	systemPrompt: string,
	args: MakeExtractionLlmArgs,
): (input: string) => Promise<string> {
	return async (input: string): Promise<string> => {
		const tmpTranscript = path.join(args.agentDir, "sessions", `.subagent-${randomUUID()}.jsonl`);
		const sessionManager = SessionManager.open(tmpTranscript);
		try {
			const { session } = await createAgentSession({
				cwd: args.workspaceDir,
				agentDir: args.agentDir,
				authStorage: args.authStorage as never,
				modelRegistry: args.modelRegistry as never,
				model: args.model as never,
				// Reasoning-aware: some models (Gemini 2.5 Pro, o-series) reject
				// "off". Derive a safe level rather than hardcoding it.
				thinkingLevel: pickInitialThinkingLevel(args.model as never),
				tools: [],
				customTools: [],
				sessionManager,
				resourceLoader: new DefaultResourceLoader({ cwd: args.workspaceDir, agentDir: args.agentDir }),
			} as never);
			if (!session) return "";
			applyPersonaOverrideToSession(session as AgentSession, systemPrompt);
			await (session as AgentSession).prompt(input);
			return lastAssistantText(session as AgentSession);
		} finally {
			try {
				fs.rmSync(tmpTranscript, { force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	};
}

/**
 * The extraction distiller — `makeIsolatedLlm` with the EXTRACTION_PROMPT pinned.
 */
export function makeExtractionLlm(args: MakeExtractionLlmArgs): ExtractionLlm {
	return makeIsolatedLlm(EXTRACTION_PROMPT, args);
}

function lastAssistantText(session: AgentSession): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role === "assistant") return flattenContent(m.content);
	}
	return "";
}
