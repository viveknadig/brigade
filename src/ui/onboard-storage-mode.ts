// src/ui/onboard-storage-mode.ts
//
// Step 0 of the onboard wizard — pick the storage mode.
//
// In Phase 2 Brigade can run against TWO storage backends:
//   filesystem  — all state under ~/.brigade/ (default, single-machine, zero deps)
//   convex      — relational + reactive + vector search (local backend or cloud)
//
// This module owns the UI for picking the mode, the convex sub-prompts
// (backend / URL / connectivity probe), and reports back a structured result.
// The caller (src/ui/onboarding.ts) writes the sentinel after the rest of the
// wizard completes.

import { CancellableLoader, Input, type SelectItem, SelectList, Text, type TUI } from "@mariozechner/pi-tui";

import { renderBrandHeader } from "./brand.js";
import { brand, selectListTheme } from "./theme.js";
import type { StorageMode } from "../storage/runtime-context.js";

export interface StorageModeResult {
	mode: StorageMode;
	/** Only set when mode === "convex". */
	convexUrl?: string;
}

export interface StorageModeStepOpts {
	/** Skip the picker entirely — used by tests + non-interactive callers. */
	preselected?: StorageModeResult;
}

/**
 * Run Step 0 of the wizard. Throws "onboarding-cancelled" if the user Escs
 * out of the mode picker (mirrors `pickProvider`'s contract).
 */
export async function pickStorageMode(
	tui: TUI,
	opts: StorageModeStepOpts = {},
): Promise<StorageModeResult> {
	if (opts.preselected) return opts.preselected;

	renderScreen(tui, "Step 0 of 5 · Storage mode");
	tui.addChild(
		new Text(
			`  ${brand.dim("Where should Brigade keep its state?")}`,
			0,
			0,
		),
	);
	tui.addChild(new Text("", 0, 0));

	const items: SelectItem[] = [
		{
			value: "filesystem",
			label: "Filesystem",
			description: "All state under ~/.brigade/ · zero deps · default",
		},
		{
			value: "convex",
			label: "Convex",
			description: "Relational + reactive + vector search · local backend or cloud",
		},
	];

	const list = new SelectList(items, items.length, selectListTheme, {
		minPrimaryColumnWidth: 12,
		maxPrimaryColumnWidth: 14,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();

	const chosen = await new Promise<SelectItem>((resolve, reject) => {
		list.onSelect = (item) => resolve(item);
		list.onCancel = () => reject(new Error("onboarding-cancelled"));
	});
	const mode = chosen.value as StorageMode;

	if (mode === "filesystem") {
		return { mode };
	}

	// Convex path — connection sub-prompts.
	const url = await pickConvexBackend(tui);
	return { mode: "convex", convexUrl: url };
}

/**
 * Step 0a/0b/0c — for convex mode: pick backend kind, prompt URL, probe.
 * Loops on probe failure until either a healthy URL is found or the user
 * Escs back (which switches them to filesystem mode silently — Esc here
 * is "I changed my mind" rather than "abort").
 */
async function pickConvexBackend(tui: TUI): Promise<string> {
	let lastError: string | null = null;

	while (true) {
		renderScreen(tui, "Step 0 of 5 · Convex backend");
		if (lastError) {
			tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
			tui.addChild(new Text(brand.dim("  Press Enter to retry, or Esc to switch to filesystem."), 0, 0));
			tui.addChild(new Text("", 0, 0));
		}

		const backendItems: SelectItem[] = [
			{
				value: "local",
				label: "Local",
				description: "127.0.0.1:3210 · use `npm run convex:dev` in another terminal",
			},
			{
				value: "existing",
				label: "Existing",
				description: "Point at a running deployment URL (local or cloud)",
			},
		];
		const list = new SelectList(backendItems, backendItems.length, selectListTheme, {
			minPrimaryColumnWidth: 10,
			maxPrimaryColumnWidth: 12,
		});
		tui.addChild(list);
		tui.setFocus(list);
		tui.requestRender();

		let kind: "local" | "existing";
		try {
			const chosen = await new Promise<SelectItem>((resolve, reject) => {
				list.onSelect = (item) => resolve(item);
				list.onCancel = () => reject(new Error("back"));
			});
			kind = chosen.value === "existing" ? "existing" : "local";
		} catch {
			// User Escd — silently revert to filesystem mode.
			throw new Error("storage-mode-revert-to-filesystem");
		}

		const defaultUrl = kind === "local" ? "http://127.0.0.1:3210" : "";

		// URL prompt.
		renderScreen(tui, "Step 0 of 5 · Convex URL");
		if (kind === "local") {
			tui.addChild(
				new Text(
					`  ${brand.dim("Enter to accept the default, or type a different URL.")}`,
					0,
					0,
				),
			);
		} else {
			tui.addChild(
				new Text(
					`  ${brand.dim("Paste your deployment URL (https://your-name.convex.cloud or self-hosted).")}`,
					0,
					0,
				),
			);
		}
		tui.addChild(new Text(brand.dim("  Esc to go back"), 0, 0));
		tui.addChild(new Text("", 0, 0));

		const input = new Input();
		if (defaultUrl.length > 0) {
			// Pi-TUI Input doesn't expose a `setValue`, but the picker treats
			// an empty submit as "use default" — we tell the user that on the
			// prompt line above.
		}
		tui.addChild(input);
		tui.setFocus(input);
		tui.requestRender();

		let raw: string;
		try {
			raw = await new Promise<string>((resolve, reject) => {
				input.onSubmit = (value: string) => resolve(value.trim());
				input.onEscape = () => reject(new Error("back"));
			});
		} catch {
			continue; // Esc — back to backend picker
		}

		const url = raw.length > 0 ? raw : defaultUrl;
		if (url.length === 0) {
			lastError = "Please enter a deployment URL.";
			continue;
		}
		if (!/^https?:\/\//i.test(url)) {
			lastError = `URL must start with http:// or https://, got "${url}".`;
			continue;
		}

		// Connectivity probe.
		tui.addChild(new Text("", 0, 0));
		const loader = new CancellableLoader(
			tui,
			(s) => brand.amber(s),
			(s) => brand.dim(s),
			`Probing ${url}…`,
		);
		tui.addChild(loader);
		tui.requestRender();

		const probe = await probeConvexBackend(url);
		tui.removeChild(loader);

		if (!probe.ok) {
			lastError = probe.reason;
			continue;
		}

		tui.addChild(
			new Text(
				`  ${brand.amber("✓")} Convex backend reachable · instance ${brand.white(probe.instanceName ?? "(unknown)")}`,
				0,
				0,
			),
		);
		tui.requestRender();
		await delay(500);
		return url;
	}
}

interface ProbeResult {
	ok: boolean;
	reason: string;
	instanceName?: string;
}

async function probeConvexBackend(url: string): Promise<ProbeResult> {
	const cleaned = url.replace(/\/+$/, "");
	const endpoint = `${cleaned}/instance_name`;
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 5_000);
		const res = await fetch(endpoint, { signal: controller.signal });
		clearTimeout(t);
		if (!res.ok) {
			return { ok: false, reason: `HTTP ${res.status} from ${endpoint}` };
		}
		const text = (await res.text()).trim();
		return { ok: true, reason: "ok", instanceName: text || undefined };
	} catch (err) {
		const msg = (err as Error)?.name === "AbortError" ? "timed out after 5s" : (err as Error).message;
		const localHint =
			cleaned.includes("127.0.0.1") || cleaned.includes("localhost")
				? "  · is `npm run convex:dev` running in another terminal?"
				: "";
		return { ok: false, reason: `Couldn't reach ${cleaned}: ${msg}${localHint}` };
	}
}

/* ────────────────────────── helpers ────────────────────────── */

function renderScreen(tui: TUI, subheader: string): void {
	for (const child of [...tui.children]) tui.removeChild(child);
	renderBrandHeader(tui);
	if (subheader) {
		tui.addChild(new Text(brand.dim("  " + "─".repeat(54)), 0, 0));
		tui.addChild(new Text("", 0, 0));
		tui.addChild(new Text(`  ${brand.amber(subheader)}`, 0, 0));
		tui.addChild(new Text("", 0, 0));
		tui.requestRender();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
