/**
 * Reference-parity re-export of Brigade's string coercion helpers.
 *
 * The upstream reference codebase puts these helpers under `src/shared/`.
 * Brigade's actual implementation lives in `src/utils/string-coerce.ts`.
 * This file is a no-behaviour shim so lifted code that imports from the
 * `shared/` path keeps compiling without forking the source of truth.
 *
 * Do NOT add behaviour here — extend `utils/string-coerce.ts` instead.
 */

export {
	readStringValue,
	normalizeNullableString,
	normalizeOptionalString,
	normalizeStringifiedOptionalString,
	normalizeOptionalLowercaseString,
	normalizeLowercaseStringOrEmpty,
	lowercasePreservingWhitespace,
	localeLowercasePreservingWhitespace,
	resolvePrimaryStringValue,
	normalizeOptionalThreadValue,
	normalizeOptionalStringifiedId,
	hasNonEmptyString,
	truncateUtf16Safe,
} from "../utils/string-coerce.js";
