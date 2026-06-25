/**
 * iMessage status / doctor probe.
 *
 * iMessage has no remote API to ping — the only way to answer "is this channel
 * actually working?" is to drive the local `imsg` binary. The probe is a
 * three-stage gate:
 *   1. the binary exists / is runnable (`imsg rpc --help` succeeds);
 *   2. the binary supports the `rpc` subcommand (an old build prints
 *      "unknown command 'rpc'" → a FATAL, non-retriable error);
 *   3. a live `chats.list {limit:1}` round-trip over the RPC stream succeeds.
 *
 * The RPC client factory is INJECTABLE (`opts.createClient`) — that is the test
 * seam: a unit test passes a fake to exercise the success / failure branches
 * with NO real `imsg` binary. Likewise the `runHelp` probe of `imsg rpc --help`
 * is injectable. Never throws — a failure surfaces as `{ ok: false, error }` so
 * `brigade channels status` / `brigade doctor` degrade gracefully.
 */

import { spawn } from "node:child_process";

import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./account-config.js";
import { createIMessageRpcClient, type IMessageRpcLike } from "./client.js";

/** Structured probe result. `ok` true ⇒ binary present + rpc works + reachable. */
export interface IMessageProbeResult {
	ok: boolean;
	/** Operator-facing error line when `ok` is false. */
	error?: string;
	/** True when the failure is non-recoverable without operator action (old binary). */
	fatal?: boolean;
	/** Round-trip time in ms. */
	elapsedMs: number;
}

/** Outcome of the `imsg rpc --help` support probe. */
interface RpcSupportResult {
	supported: boolean;
	error?: string;
	fatal?: boolean;
}

export interface IMessageProbeArgs {
	/** `imsg` binary path. Defaults to `"imsg"`. */
	cliPath?: string;
	/** Optional chat.db override. */
	dbPath?: string;
	/** Probe timeout in ms (default 10s). */
	timeoutMs?: number;
	/**
	 * TEST SEAM: run `imsg rpc --help` and return its combined output + exit code.
	 * Production spawns the binary; tests inject a fake.
	 */
	runHelp?: (cliPath: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number | null }>;
	/**
	 * TEST SEAM: build the RPC client used for the live `chats.list` call.
	 * Production constructs the real one; tests inject a fake.
	 */
	createClient?: (args: { cliPath: string; dbPath?: string }) => Promise<IMessageRpcLike>;
}

/** Run `imsg rpc --help` with a timeout, capturing combined output + exit code. */
function defaultRunHelp(cliPath: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (code: number | null): void => {
			if (settled) return;
			settled = true;
			resolve({ stdout, stderr, code });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cliPath, ["rpc", "--help"], { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ stdout: "", stderr: err instanceof Error ? err.message : String(err), code: 1 });
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* best-effort */
			}
			done(null);
		}, timeoutMs);
		if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString("utf8");
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});
		child.on("error", (err) => {
			stderr += err instanceof Error ? err.message : String(err);
			done(1);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done(code);
		});
	});
}

/** Probe whether the binary supports the `rpc` subcommand. */
export async function probeRpcSupport(args: IMessageProbeArgs): Promise<RpcSupportResult> {
	const cliPath = args.cliPath?.trim() || "imsg";
	const timeoutMs = args.timeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;
	const runHelp = args.runHelp ?? defaultRunHelp;
	let result: { stdout: string; stderr: string; code: number | null };
	try {
		result = await runHelp(cliPath, timeoutMs);
	} catch (err) {
		return { supported: false, error: err instanceof Error ? err.message : String(err) };
	}
	const combined = `${result.stdout}\n${result.stderr}`.trim();
	const normalized = combined.toLowerCase();
	if (normalized.includes("unknown command") && normalized.includes("rpc")) {
		return {
			supported: false,
			fatal: true,
			error: 'imsg CLI does not support the "rpc" subcommand (update imsg)',
		};
	}
	if (result.code === 0) return { supported: true };
	return {
		supported: false,
		error: combined || `imsg rpc --help failed (code ${result.code ?? "unknown"})`,
	};
}

/**
 * Run the full iMessage probe (binary + rpc support + live `chats.list`).
 * Never throws.
 */
export async function probeIMessage(args: IMessageProbeArgs = {}): Promise<IMessageProbeResult> {
	const started = Date.now();
	const cliPath = args.cliPath?.trim() || "imsg";
	const dbPath = args.dbPath?.trim() || undefined;
	const timeoutMs = args.timeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;

	const support = await probeRpcSupport({ cliPath, timeoutMs, ...(args.runHelp ? { runHelp: args.runHelp } : {}) });
	if (!support.supported) {
		return {
			ok: false,
			error: support.error ?? "imsg rpc unavailable",
			elapsedMs: Date.now() - started,
			...(support.fatal ? { fatal: true } : {}),
		};
	}

	let client: IMessageRpcLike;
	try {
		client = args.createClient
			? await args.createClient({ cliPath, ...(dbPath ? { dbPath } : {}) })
			: await createIMessageRpcClient({ cliPath, ...(dbPath ? { dbPath } : {}) });
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - started };
	}
	try {
		await client.request("chats.list", { limit: 1 }, { timeoutMs });
		return { ok: true, elapsedMs: Date.now() - started };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - started };
	} finally {
		await client.stop();
	}
}
