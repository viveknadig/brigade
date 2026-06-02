/**
 * Compute the byte length of a value when serialised as UTF-8 JSON.
 *
 * Used by `sessions_history` to cap response size at 80 KiB even when the
 * transcript chunk's character count is well under the cap — a chunk full
 * of 4-byte emoji can blow past a byte budget computed via `.length` on
 * the string.
 *
 * Implementation: encode via TextEncoder (zero allocations beyond the
 * intermediate buffer, fast in modern V8) and return the buffer's byte
 * length. The result is exact, not estimated.
 */

const ENCODER = new TextEncoder();

export function jsonUtf8Bytes(value: unknown): number {
	const serialised = JSON.stringify(value);
	if (serialised === undefined) return 0;
	return ENCODER.encode(serialised).byteLength;
}
