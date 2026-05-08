/**
 * Summarize a Pi tool-execution result into a short single-line preview for
 * the chat / connect TUIs.
 *
 * Pi's `ToolExecutionEndEvent` carries `result: any` — the shape varies by
 * tool (string for `bash`, object for `read`/`grep`, array of blocks for
 * MCP-style tools). We don't want to dump JSON into the chat; we want
 * something legible after the `✓ tool_name` line.
 *
 * Mirrors openclaw's interactive-mode tool-result rendering shape (which
 * uses Pi-TUI's MarkdownComponent.append for streamed output). Brigade's
 * shorter format trades depth for compactness — a one-line preview keeps
 * the chat scannable.
 */
export interface ToolResultSummary {
	/** Single-line preview, never longer than `maxLength` chars */
	preview: string;
	/** Whether the result was non-empty (false → caller may hide entirely) */
	hasContent: boolean;
}

const DEFAULT_MAX_LENGTH = 120;

export function summarizeToolResult(
	result: unknown,
	opts: { maxLength?: number } = {},
): ToolResultSummary {
	const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

	if (result == null) return { preview: "", hasContent: false };

	let text: string;
	if (typeof result === "string") {
		text = result;
	} else if (Array.isArray(result)) {
		// MCP-style: array of `{ type: "text", text: string }` blocks. Join them.
		const pieces: string[] = [];
		for (const block of result) {
			if (block && typeof block === "object") {
				const b = block as Record<string, unknown>;
				if (typeof b.text === "string") pieces.push(b.text);
				else if (typeof b.content === "string") pieces.push(b.content);
			} else if (typeof block === "string") {
				pieces.push(block);
			}
		}
		text = pieces.join("\n");
	} else if (typeof result === "object") {
		// Pi's read/grep/etc. return objects. Try common keys before falling
		// back to JSON. `details` and `content` are Brigade's own AgentTool
		// shape; `output` and `text` cover Pi's bash + various MCP servers.
		const r = result as Record<string, unknown>;
		if (typeof r.content === "string") text = r.content;
		else if (typeof r.output === "string") text = r.output;
		else if (typeof r.text === "string") text = r.text;
		else if (typeof r.message === "string") text = r.message;
		else {
			try {
				text = JSON.stringify(result);
			} catch {
				text = String(result);
			}
		}
	} else {
		text = String(result);
	}

	// Collapse whitespace so a multi-line bash output renders on one line.
	// Tabs → space, CR/LF → space, runs of whitespace → single space.
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!collapsed) return { preview: "", hasContent: false };

	if (collapsed.length <= maxLength) {
		return { preview: collapsed, hasContent: true };
	}
	return { preview: `${collapsed.slice(0, maxLength - 1)}…`, hasContent: true };
}
