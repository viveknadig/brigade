/**
 * iMessage RPC client — newline-delimited JSON-RPC 2.0 over a child process's
 * stdin/stdout.
 *
 * The transport spawns the third-party `imsg` CLI as `imsg rpc [--db <path>]`
 * and speaks JSON-RPC 2.0 framed ONE object per `\n`:
 *   - a request is `{ jsonrpc:"2.0", id, method, params }\n` written to stdin;
 *   - a line with a non-null `id` is a RESPONSE matched against the pending map;
 *   - a line with a `method` and NO `id` is an inbound NOTIFICATION dispatched to
 *     `onNotification` (the monitor subscribes to these for new messages).
 *
 * This is the iMessage analogue of a token-channel's transport SDK. There is a
 * hard TEST SEAM: the real client REFUSES to spawn a subprocess in tests (see
 * {@link isTestEnv}). Unit tests inject a {@link IMessageRpcLike} fake on the
 * adapter/connection seam instead, so send / normalize / probe / dedupe are all
 * exercised with NO real `imsg` binary and NO live subprocess.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./account-config.js";

/** A JSON-RPC error object. */
export type IMessageRpcError = { code?: number; message?: string; data?: unknown };

/** A parsed inbound notification (a line with a `method` and no `id`). */
export type IMessageRpcNotification = { method: string; params?: unknown };

/** Cross-cutting runtime hooks the client surfaces (logging only). */
export interface IMessageRpcRuntime {
	error?: (message: string) => void;
	info?: (message: string) => void;
}

/** Construction options for {@link IMessageRpcClient}. */
export interface IMessageRpcClientOptions {
	/** Path to the `imsg` binary. Defaults to `"imsg"` (found on PATH). */
	cliPath?: string;
	/** Optional chat.db override (`~`-expanded here). */
	dbPath?: string;
	/** Logging hooks (stderr lines, parse failures). */
	runtime?: IMessageRpcRuntime;
	/** Called for every inbound notification (`{ method, params }`). */
	onNotification?: (msg: IMessageRpcNotification) => void;
}

/**
 * The minimal transport surface the adapter / send path depend on. The real
 * {@link IMessageRpcClient} implements it; tests inject a fake satisfying it.
 * Keeping the dependency on this interface (NOT the concrete class) is the test
 * seam — a unit test never touches a child process.
 */
export interface IMessageRpcLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
	waitForClose(): Promise<void>;
}

/** One pending request awaiting its matching response. */
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

/**
 * True in a test environment. The real client REFUSES to spawn `imsg rpc` here
 * so a stray unit test can never shell out to the binary — tests must inject a
 * mock {@link IMessageRpcLike} on the seam instead.
 */
export function isTestEnv(): boolean {
	if (process.env.NODE_ENV === "test") return true;
	const vitest = (process.env.VITEST ?? "").trim().toLowerCase();
	return Boolean(vitest);
}

/** Expand a leading `~` to the user's home dir. */
function expandUserPath(p: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return trimmed;
}

function formatErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Long-lived JSON-RPC 2.0 client over an `imsg rpc` child process. A pending-id
 * map matches responses; an `onNotification` callback fans out inbound events;
 * `failAll` rejects every in-flight request when the child errors or closes.
 */
export class IMessageRpcClient implements IMessageRpcLike {
	private readonly cliPath: string;
	private readonly dbPath: string | undefined;
	private readonly runtime: IMessageRpcRuntime | undefined;
	private readonly onNotification: ((msg: IMessageRpcNotification) => void) | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly closed: Promise<void>;
	private closedResolve: (() => void) | null = null;
	private child: ChildProcessWithoutNullStreams | null = null;
	private reader: Interface | null = null;
	private nextId = 1;

	constructor(opts: IMessageRpcClientOptions = {}) {
		this.cliPath = opts.cliPath?.trim() || "imsg";
		this.dbPath = opts.dbPath?.trim() ? expandUserPath(opts.dbPath) : undefined;
		this.runtime = opts.runtime;
		this.onNotification = opts.onNotification;
		this.closed = new Promise((resolve) => {
			this.closedResolve = resolve;
		});
	}

	/** Spawn the child + wire stdout (responses/notifications) and stderr (logs). Idempotent. */
	async start(): Promise<void> {
		if (this.child) return;
		if (isTestEnv()) {
			throw new Error("Refusing to start imsg rpc in test environment; inject a mock iMessage RPC client");
		}
		const args = ["rpc"];
		if (this.dbPath) args.push("--db", this.dbPath);
		const child = spawn(this.cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		this.reader = createInterface({ input: child.stdout });
		this.reader.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			this.handleLine(trimmed);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				const t = line.trim();
				if (t) this.runtime?.error?.(`imsg rpc: ${t}`);
			}
		});
		child.on("error", (err) => {
			this.failAll(err instanceof Error ? err : new Error(formatErr(err)));
			this.closedResolve?.();
		});
		child.on("close", (code, signal) => {
			if (code !== 0 && code !== null) {
				const reason = signal ? `signal ${signal}` : `code ${code}`;
				this.failAll(new Error(`imsg rpc exited (${reason})`));
			} else {
				this.failAll(new Error("imsg rpc closed"));
			}
			this.closedResolve?.();
		});
	}

	/** Gracefully end stdin, then SIGTERM after a 500ms grace if still alive. */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.reader?.close();
		this.reader = null;
		try {
			child.stdin?.end();
		} catch {
			/* best-effort */
		}
		this.child = null;
		await Promise.race([
			this.closed,
			new Promise<void>((resolve) => {
				const t = setTimeout(() => {
					if (!child.killed) {
						try {
							child.kill("SIGTERM");
						} catch {
							/* best-effort */
						}
					}
					resolve();
				}, 500);
				if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
			}),
		]);
	}

	/** Resolves when the child has errored or closed. */
	async waitForClose(): Promise<void> {
		await this.closed;
	}

	/** Issue a JSON-RPC request and await its matching response (10s default timeout). */
	async request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
		if (!this.child || !this.child.stdin) throw new Error("imsg rpc not running");
		const id = this.nextId++;
		const payload = { jsonrpc: "2.0", id, method, params: params ?? {} };
		const line = `${JSON.stringify(payload)}\n`;
		const timeoutMs = opts?.timeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;
		const response = new Promise<T>((resolve, reject) => {
			const key = String(id);
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(key);
							reject(new Error(`imsg rpc timeout (${method})`));
						}, timeoutMs)
					: undefined;
			if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
				(timer as { unref: () => void }).unref();
			}
			this.pending.set(key, { resolve: (v) => resolve(v as T), reject, timer });
		});
		this.child.stdin.write(line);
		return await response;
	}

	/** Parse one stdout line: a non-null `id` is a response, a bare `method` is a notification. */
	private handleLine(line: string): void {
		let parsed: {
			id?: string | number | null;
			result?: unknown;
			error?: IMessageRpcError;
			method?: string;
			params?: unknown;
		};
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			this.runtime?.error?.(`imsg rpc: failed to parse ${line}: ${formatErr(err)}`);
			return;
		}
		if (parsed.id !== undefined && parsed.id !== null) {
			const key = String(parsed.id);
			const pending = this.pending.get(key);
			if (!pending) return;
			if (pending.timer) clearTimeout(pending.timer);
			this.pending.delete(key);
			if (parsed.error) {
				const baseMessage = parsed.error.message ?? "imsg rpc error";
				const details = parsed.error.data;
				const code = parsed.error.code;
				const suffixes: string[] = [];
				if (typeof code === "number") suffixes.push(`code=${code}`);
				if (details !== undefined) {
					const detailText = typeof details === "string" ? details : JSON.stringify(details);
					if (detailText) suffixes.push(detailText);
				}
				const msg = suffixes.length > 0 ? `${baseMessage}: ${suffixes.join(" ")}` : baseMessage;
				pending.reject(new Error(msg));
				return;
			}
			pending.resolve(parsed.result);
			return;
		}
		if (parsed.method) {
			this.onNotification?.({ method: parsed.method, params: parsed.params });
		}
	}

	/** Reject every in-flight request with `err` and clear their timers. */
	private failAll(err: Error): void {
		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pending.clear();
	}
}

/** Construct + start a real RPC client. */
export async function createIMessageRpcClient(opts: IMessageRpcClientOptions = {}): Promise<IMessageRpcClient> {
	const client = new IMessageRpcClient(opts);
	await client.start();
	return client;
}
