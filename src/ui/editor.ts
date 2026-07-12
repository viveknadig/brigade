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

import { Editor } from "@earendil-works/pi-tui";

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
	"provider", // [<provider>] — optional (no arg lists providers)
	"reasoning", // [on|off] — optional toggle
	"paste", // no arg — reads the clipboard
	"attach", // [<path>] — optional (no arg lists what's staged)
	"detach", // [<n>|all] — optional (no arg detaches everything)
]);

export class BrigadeEditor extends Editor {
	/**
	 * Fired on a raw Ctrl+V (0x16) — "paste an image from the clipboard".
	 *
	 * A terminal forwards keystrokes and TEXT; it never forwards binary clipboard
	 * data. So an image paste cannot arrive as input — we have to notice the
	 * keypress and go ask the OS ourselves. That is the whole trick.
	 *
	 * The catch, stated plainly because it decides how we document this: many
	 * terminals (Windows Terminal among them) bind Ctrl+V to their OWN paste and
	 * consume it, so 0x16 never reaches us — and when the clipboard holds an image
	 * with no text, their paste inserts nothing and we see no input at all. There
	 * is no way for an application to intercept a keystroke the terminal ate. So
	 * `/paste` exists as the guaranteed path, and this handles every terminal that
	 * does forward the key.
	 */
	onImagePaste?: () => void;

	override handleInput(data: string): void {
		// Ctrl+V (0x16) and Alt+V (ESC v) both mean "paste an image from the clipboard".
		//
		// BOTH exist because Ctrl+V alone is not enough on Windows. Windows Terminal
		// binds Ctrl+V to its OWN paste action, which inserts the clipboard's TEXT —
		// and when the clipboard holds an image with no text, it inserts nothing at
		// all. The keypress is consumed by the terminal and never reaches us, so
		// there is nothing for this method to hook. Alt+V is not bound by any
		// mainstream terminal, so it reaches the application intact and gives Windows
		// operators a real keystroke instead of a command they have to type.
		if ((data === "\x16" || data === "\x1bv" || data === "\x1bV") && this.onImagePaste) {
			this.onImagePaste();
			return;
		}
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
