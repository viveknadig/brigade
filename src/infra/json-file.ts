/**
 * Atomic JSON file loader + saver.
 *
 * Both are sync (fs.* sync APIs) to keep the per-storePath FIFO lock queue
 * in `session-store-lock.ts` simple — the queue serialises operations at
 * the API boundary, so the file I/O does not need to be async-aware.
 *
 * Save semantics (`tmp + rename`):
 *   1. Write the new content to `<path>.tmp` with `0o600` perms.
 *   2. `fs.renameSync(<path>.tmp, <path>)` — atomic on every supported
 *      filesystem (POSIX rename, NTFS MoveFileTransacted under the hood).
 *
 * A crash between step 1 and step 2 leaves the `.tmp` file behind but
 * the existing `<path>` is untouched. A crash after step 2 has nothing
 * to recover — the rename was atomic.
 *
 * Load semantics:
 *   - Missing file → returns `null`.
 *   - Empty file → returns `null` (treated as "no state yet").
 *   - Malformed JSON → throws. The caller (session-store) catches and
 *     decides whether to back up + reset or propagate.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function loadJsonFile<T>(filePath: string): T | null {
	if (!fs.existsSync(filePath)) return null;
	const raw = fs.readFileSync(filePath, "utf8");
	if (!raw.trim()) return null;
	return JSON.parse(raw) as T;
}

export function saveJsonFile(filePath: string, value: unknown): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		fs.chmodSync(tmp, 0o600);
	} catch {
		/* best-effort on platforms without chmod */
	}
	fs.renameSync(tmp, filePath);
}
