/**
 * ApprovalPrompt — inline TUI card the user picks Y / A / P / N from when
 * a gated tool call (today: `bash`) needs operator consent.
 *
 * Rendered as a single Component inside the connect-mode TUI; takes focus
 * when displayed, swaps focus back to the editor when resolved. Two
 * states:
 *
 *   1. `"menu"`    — four-letter shortcut row (Y/A/P/N) for the four
 *                    operator decisions.
 *   2. `"pattern"` — operator picked "P" (Allow pattern); we collect a
 *                    regex string with Pi-TUI's `Input` then resolve.
 *
 * Visual style mirrors the user's mock:
 *
 *   ┌─ Brigade wants to run ────────────────────────────────┐
 *   │  node -e "console.log(0.06 * 100000000)"              │
 *   │                                                       │
 *   │  [Y] Allow once   [A] Allow always                    │
 *   │  [P] Allow pattern…   [N] Deny                        │
 *   └───────────────────────────────────────────────────────┘
 *
 * Brigade brand: amber accent on the action letters; dim on the labels.
 *
 * Why a custom Component and not a `SelectList`: the operator picks via a
 * single letter, not arrow keys. SelectList works fine but requires
 * Up/Down + Enter; single-key dispatch is the muscle-memory pattern other
 * AI CLIs use (Claude Code, Cursor agent mode). One keystroke decides.
 */

import {
	type Component,
	decodeKittyPrintable,
	Input,
	matchesKey,
	type TUI,
	visibleWidth,
} from "@mariozechner/pi-tui";

import { brand } from "../ui/theme.js";

export type ApprovalDecisionKind = "allow-once" | "allow-always" | "allow-pattern" | "deny";

export interface ApprovalRenderRequest {
	id: string;
	command: string;
	toolName: string;
	cwd?: string;
}

export interface ApprovalResolution {
	decision: ApprovalDecisionKind;
	pattern?: string;
}

export interface ApprovalPromptOptions {
	tui: TUI;
	request: ApprovalRenderRequest;
	onResolve: (resolution: ApprovalResolution) => void;
	/** Called when the operator cancels via Esc (treated as deny). */
	onCancel?: () => void;
}

const TITLE = " Brigade wants to run ";

export class ApprovalPrompt implements Component {
	private state: "menu" | "pattern" = "menu";
	private patternInput: Input | null = null;
	private resolved = false;
	/** Last rendered width — captured so `pattern` mode can re-frame the input. */
	private lastWidth = 80;

	constructor(private readonly opts: ApprovalPromptOptions) {}

	invalidate(): void {
		// Stateless renderer — nothing to invalidate. Required by the
		// Component interface.
	}

	render(width: number): string[] {
		this.lastWidth = Math.max(40, Math.min(width, 100));
		if (this.state === "pattern") return this.renderPatternState();
		return this.renderMenuState();
	}

	private renderMenuState(): string[] {
		const w = this.lastWidth;
		const inner = w - 4; // 2 for "│ " + 2 for " │"
		const titleLine = drawTitleLine(w, TITLE);
		const cmdLine = boxLine(inner, truncateForBox(this.opts.request.command, inner));
		const spacer = boxLine(inner, "");
		const row1 = boxLine(
			inner,
			`${brand.amber("[Y]")} ${brand.dim("Allow once")}   ${brand.amber("[A]")} ${brand.dim("Allow always")}`,
		);
		const row2 = boxLine(
			inner,
			`${brand.amber("[P]")} ${brand.dim("Allow pattern…")}   ${brand.amber("[N]")} ${brand.dim("Deny")}`,
		);
		const bottom = drawHorizLine(w, "└", "┘");
		const hint = `   ${brand.dim("Esc = deny · single keystroke resolves")}`;
		return [titleLine, cmdLine, spacer, row1, row2, bottom, hint];
	}

	private renderPatternState(): string[] {
		const w = this.lastWidth;
		const titleLine = drawTitleLine(w, " Approve matching pattern ");
		const helpLine = boxLine(
			w - 4,
			`${brand.dim("Regex matched against the FULL command. e.g.")} ${brand.amber("^git status$")}`,
		);
		const helpLine2 = boxLine(
			w - 4,
			`${brand.dim("Cancel with Esc · Enter to confirm")}`,
		);
		const bottom = drawHorizLine(w, "└", "┘");
		const inputBlock = this.patternInput?.render(w - 4) ?? [];
		const framedInput = inputBlock.map((line) => {
			const visible = visibleWidth(line);
			const pad = " ".repeat(Math.max(0, w - 4 - visible));
			return `${brand.dim("│ ")}${line}${pad}${brand.dim(" │")}`;
		});
		return [titleLine, helpLine, helpLine2, ...framedInput, bottom];
	}

	handleInput(keyData: string): void {
		if (this.resolved) return;
		if (this.state === "pattern") {
			this.handlePatternInput(keyData);
			return;
		}
		// MENU state — single-letter dispatch + Esc. Pi-TUI uses the kitty
		// keyboard protocol, so `keyData` is a CSI-u sequence (e.g.
		// `\x1b[121u` for 'y'), NOT a literal char. Use the helpers.
		if (matchesKey(keyData, "escape")) {
			this.opts.onCancel?.();
			this.resolve({ decision: "deny" });
			return;
		}
		const ch = decodeKittyPrintable(keyData);
		if (!ch) return;
		switch (ch.toLowerCase()) {
			case "y":
				this.resolve({ decision: "allow-once" });
				return;
			case "a":
				this.resolve({ decision: "allow-always" });
				return;
			case "p":
				this.enterPatternMode();
				return;
			case "n":
				this.resolve({ decision: "deny" });
				return;
		}
	}

	private handlePatternInput(keyData: string): void {
		const input = this.patternInput;
		if (!input) return;
		// Esc → back to deny.
		if (matchesKey(keyData, "escape")) {
			this.resolve({ decision: "deny" });
			return;
		}
		// Forward everything else to the Input. Submission handled via
		// the input's `onSubmit` we registered in `enterPatternMode`.
		input.handleInput(keyData);
	}

	private enterPatternMode(): void {
		this.state = "pattern";
		const input = new Input();
		input.onSubmit = (value: string): void => {
			const pattern = value.trim();
			if (!pattern) {
				// Empty pattern → treat as "allow-once" so the operator
				// isn't trapped (they intended to allow at least this call).
				this.resolve({ decision: "allow-once" });
				return;
			}
			this.resolve({ decision: "allow-pattern", pattern });
		};
		input.onEscape = (): void => {
			this.resolve({ decision: "deny" });
		};
		this.patternInput = input;
		this.opts.tui.setFocus(input);
		this.opts.tui.requestRender();
	}

	private resolve(resolution: ApprovalResolution): void {
		if (this.resolved) return;
		this.resolved = true;
		this.opts.onResolve(resolution);
	}
}

/* ─────────────────────────── helpers ─────────────────────────── */

function drawTitleLine(width: number, title: string): string {
	const styledTitle = brand.amber(title);
	const titleVisibleLen = title.length;
	const remaining = Math.max(2, width - titleVisibleLen - 1);
	return `${brand.dim("┌─")}${styledTitle}${brand.dim("─".repeat(remaining))}${brand.dim("┐")}`;
}

function drawHorizLine(width: number, left: string, right: string): string {
	const inner = "─".repeat(Math.max(0, width - 2));
	return brand.dim(`${left}${inner}${right}`);
}

function boxLine(innerWidth: number, content: string): string {
	const visible = visibleWidth(content);
	const pad = Math.max(0, innerWidth - visible);
	return `${brand.dim("│ ")}${content}${" ".repeat(pad)}${brand.dim(" │")}`;
}

/**
 * Truncate a multi-line / long command string to fit one box line. We
 * intentionally don't word-wrap — the box should show one canonical line
 * (the command); the agent's reasoning context already shows the full
 * thing. Newlines flatten to space, ANSI-free, truncate with ellipsis.
 */
function truncateForBox(raw: string, maxVisible: number): string {
	const flat = raw.replace(/[\r\n]+/g, " ").trim();
	if (visibleWidth(flat) <= maxVisible) return flat;
	const cap = Math.max(8, maxVisible - 1);
	return `${flat.slice(0, cap)}…`;
}
