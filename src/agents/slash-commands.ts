// Slash-command intercepts that run BEFORE the message reaches the agent
// loop. The CLI / gateway calls `parseSlashCommand` on every inbound user
// message; if it returns a `Handled` result, the loop short-circuits and
// the side-effect (model switch, session reset, etc.) runs locally
// without burning a model call.
//
// Why local intercepts and not let the model handle it: the model can't
// switch its own model. The model can't truncate its own session. These
// are operator-level commands and need to fire deterministically.
//
// The current command set is small on purpose — slash commands are a UX
// surface the user has to remember. We only ship what's load-bearing for
// running the loop:
//
//   /model <provider/modelId>   change the model used for the NEXT turn
//   /model                      print the active model
//   /thinking <off|low|med|high>  set thinking level for next turn
//   /reset                      forget the running session and start fresh
//   /help                       list available commands

export type SlashCommandResult =
  | {
      type: "passthrough";
      // Original message — caller sends it to the agent unchanged.
      message: string;
    }
  | {
      type: "model";
      // New (provider, modelId) for the next turn. Caller persists to
      // sessions.json and uses this on the next runSingleTurn call.
      provider: string;
      modelId: string;
    }
  | {
      type: "thinking";
      level: "off" | "low" | "medium" | "high";
    }
  | {
      type: "reset";
    }
  | {
      type: "help";
    }
  | {
      type: "error";
      // User-facing error string — bad arg shape, unknown command, etc.
      message: string;
    };

export interface SlashCommandHelpEntry {
  command: string;
  description: string;
}

export const SLASH_COMMAND_HELP: SlashCommandHelpEntry[] = [
  {
    command: "/model <provider/modelId>",
    description:
      "Switch the model for the next turn (e.g. `/model anthropic/claude-opus-4-7`).",
  },
  {
    command: "/model",
    description: "Print the active provider/model for this session.",
  },
  {
    command: "/thinking <off|low|medium|high>",
    description: "Set the thinking level for the next turn.",
  },
  {
    command: "/reset",
    description: "Forget the running session and start a new one on the next turn.",
  },
  {
    command: "/help",
    description: "Show this list.",
  },
];

const KNOWN_THINKING_LEVELS = new Set(["off", "low", "medium", "high"]);

export function parseSlashCommand(rawMessage: string): SlashCommandResult {
  if (typeof rawMessage !== "string") {
    return { type: "passthrough", message: String(rawMessage ?? "") };
  }
  const trimmed = rawMessage.trimStart();
  if (trimmed.length === 0 || trimmed[0] !== "/") {
    return { type: "passthrough", message: rawMessage };
  }
  const newlineIdx = trimmed.indexOf("\n");
  // Slash commands occupy ONE line. If the first line is a slash command
  // and there's content after a newline, keep the post-newline content as
  // a follow-up message and let the command run first. The caller can
  // re-invoke the parser on the rest.
  const commandLine = newlineIdx >= 0 ? trimmed.slice(0, newlineIdx) : trimmed;

  // Tokenise. Quoted strings are NOT special — we don't need them yet.
  const parts = commandLine.split(/\s+/u).filter((p) => p.length > 0);
  const head = parts[0]?.toLowerCase() ?? "";
  const rest = parts.slice(1);

  switch (head) {
    case "/model":
      return parseModelCommand(rest);
    case "/thinking":
      return parseThinkingCommand(rest);
    case "/reset":
      if (rest.length > 0) {
        return { type: "error", message: "/reset takes no arguments" };
      }
      return { type: "reset" };
    case "/help":
      return { type: "help" };
    default:
      // Unknown slash command — pass through as-is (the model may know
      // what to do with it). This is intentional: we don't want to error
      // on user-defined / future-defined commands.
      return { type: "passthrough", message: rawMessage };
  }
}

function parseModelCommand(rest: string[]): SlashCommandResult {
  if (rest.length === 0) {
    // /model with no args = print active model. Caller decides how to
    // surface; we encode it as a help-style result for now.
    return { type: "help" };
  }
  if (rest.length > 1) {
    return {
      type: "error",
      message: "/model expects exactly one argument (provider/modelId)",
    };
  }
  const ref = rest[0]!;
  // Split on the FIRST slash — provider names never contain slashes, but
  // model IDs do. OpenRouter uses `openrouter` as provider and routes via
  // model IDs like `openai/gpt-5.4-mini`, so `/model openrouter/openai/gpt-5.4-mini`
  // must produce provider=`openrouter`, modelId=`openai/gpt-5.4-mini`.
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) {
    return {
      type: "error",
      message:
        "/model argument must be in 'provider/modelId' form " +
        "(e.g. anthropic/claude-opus-4-7 or openrouter/openai/gpt-5.4-mini)",
    };
  }
  const provider = ref.slice(0, slash).trim();
  const modelId = ref.slice(slash + 1).trim();
  if (!isValidProvider(provider) || !isValidModelId(modelId)) {
    return {
      type: "error",
      message: "/model provider and modelId must be non-empty identifiers",
    };
  }
  return { type: "model", provider, modelId };
}

function parseThinkingCommand(rest: string[]): SlashCommandResult {
  if (rest.length !== 1) {
    return {
      type: "error",
      message: "/thinking expects exactly one argument (off | low | medium | high)",
    };
  }
  const level = rest[0]!.toLowerCase();
  if (!KNOWN_THINKING_LEVELS.has(level)) {
    return {
      type: "error",
      message: `/thinking expects one of: ${[...KNOWN_THINKING_LEVELS].join(", ")}`,
    };
  }
  return {
    type: "thinking",
    level: level as "off" | "low" | "medium" | "high",
  };
}

function isValidProvider(value: string): boolean {
  // Provider names are short, never contain slashes (we split on the first
  // slash to separate provider from modelId).
  if (value.length === 0 || value.length > 64) return false;
  return /^[a-z0-9._\-:@]+$/i.test(value);
}

function isValidModelId(value: string): boolean {
  // Model IDs are wider — OpenRouter routes via `openai/gpt-5.4-mini`,
  // `anthropic/claude-opus-4-7`, `mistralai/mixtral-8x7b-instruct` etc.,
  // so we MUST permit slashes in the modelId portion. Bedrock + others
  // also use colons (e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`).
  // We just refuse whitespace and shell metacharacters.
  if (value.length === 0 || value.length > 128) return false;
  return /^[a-z0-9._\-:@/]+$/i.test(value);
}
