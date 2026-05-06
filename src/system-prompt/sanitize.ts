// Sanitisation helpers for text injected into the system prompt.
//
// Strips invisible Unicode that could be used to smuggle hidden directives
// past the model: control codepoints (Cc), format codepoints (Cf - includes
// zero-width spaces and bidi overrides), and the line/paragraph separators
// U+2028 / U+2029 that some terminals render but most LLMs treat as line
// breaks. The latter two MUST be written as Unicode escape sequences below
// because TypeScript's lexer treats raw line/paragraph separators inside a
// regex literal as line terminators, producing a parse error.

const INVISIBLE_PATTERN: RegExp = new RegExp(
  "[\\p{Cc}\\p{Cf}\\u2028\\u2029]",
  "gu",
);

export function sanitizeForPromptLiteral(value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return "";
  return value.replace(INVISIBLE_PATTERN, "");
}

// Wrap text from an untrusted source (user-controlled file contents,
// remote API output) so the model treats it as data rather than
// instructions. HTML-escapes < and > to defang prompt-injection attempts
// that nest tags.
export function wrapUntrustedDataBlock(args: {
  label: string;
  text: string;
  maxChars?: number;
}): string {
  const limit = args.maxChars ?? 10_000;
  const sanitised = sanitizeForPromptLiteral(args.text);
  const clipped =
    sanitised.length > limit
      ? sanitised.slice(0, limit) + `\n...[truncated ${sanitised.length - limit} chars]`
      : sanitised;
  const escaped = clipped.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<untrusted-${args.label}>\n${escaped}\n</untrusted-${args.label}>`;
}
