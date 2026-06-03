/**
 * Brigade's Editor — thin Pi-TUI subclass that fixes one UX quirk.
 *
 * Pi-TUI's stock `Editor` treats Enter on a slash-command suggestion as
 * "accept + submit-immediately" (`editor.js:507-519` — `tui.select.confirm`
 * applies the completion and falls through to `submitValue()`). That works
 * for arg-less commands (`/help`, `/exit`) but is wrong for commands that
 * take a REQUIRED argument (`/reasoning <on|off>`, `/thinking <level>`,
 * `/mute <agent-id>`) — the user expects to inspect / edit the inserted
 * text before sending.
 *
 * Pi already has an "accept + don't submit" path on Tab
 * (`editor.js:492-505`). When the autocomplete popup is showing AND the
 * user has typed a command that needs an argument, we translate Enter →
 * Tab so the user's Enter on a popup selection just inserts the command
 * into the editor with a trailing space and waits for them to type the
 * arg + a real Enter to submit.
 *
 * For arg-less / optional-arg commands (`/agents`, `/help`, `/agent`,
 * `/sessions`, etc.) the user expects a single Enter to submit — same
 * as Pi's default. Two-Enter behaviour is a UX regression we explicitly
 * opt OUT of here.
 *
 * Outside the popup, Enter retains its normal "submit" semantics.
 */

import { Editor } from "@mariozechner/pi-tui";

// Slash commands whose argument is OPTIONAL (or absent) — Enter should
// submit immediately even when the autocomplete popup is showing. Kept
// in sync with `SLASH_COMMANDS` in `src/cli/commands/connect.ts`.
const NO_REQUIRED_ARG = new Set([
	"help",
	"exit",
	"quit",
	"abort",
	"usage",
	"compact",
	"agents", // no arg
	"agent", // [<agent-id>] — optional
	"session", // [<session-key>] — optional
	"sessions", // [--all] — optional
	"model", // [<model-id>] — optional
	"reasoning", // [on|off] — optional toggle
]);

export class BrigadeEditor extends Editor {
	override handleInput(data: string): void {
		// Pi's handleInput recognises both `\r` and `\n` as Enter (see
		// `editor.js:586-613`). Translate either to Tab `\t` ONLY when the
		// autocomplete popup is showing AND the command needs a required
		// argument. Otherwise Enter submits normally.
		if (this.isShowingAutocomplete() && (data === "\r" || data === "\n")) {
			const text = this.getText();
			// Match a slash command that hasn't been argument-typed yet:
			// `/<name>` with optional trailing whitespace. If the user has
			// already typed an arg (text contains a space + chars), we keep
			// Pi's default submit path too — the autocomplete popup at that
			// point is showing argument completions, not command completions.
			const match = text.match(/^\/([a-z][a-z0-9_-]*)\s*$/);
			if (match && NO_REQUIRED_ARG.has(match[1] ?? "")) {
				// Arg-less or optional-arg command typed in full — let Pi
				// accept + submit in one Enter (the default behaviour).
				super.handleInput(data);
				return;
			}
			// Either the command needs a required arg, the text is partial,
			// or the popup is showing argument completions — translate to
			// Tab so the user can edit before sending.
			super.handleInput("\t");
			return;
		}
		super.handleInput(data);
	}
}
