/**
 * Re-export shim for Brigade's structured subsystem logger.
 *
 * Brigade ships its actual logger implementation at `logging/subsystem-logger.ts`.
 * Lifted code references the shorter `logging/subsystem.js` import path used
 * by the upstream reference codebase. This file lets new modules import
 * from either path without forking the implementation.
 *
 * Do NOT add behavior here — extend `subsystem-logger.ts` instead.
 */

export { createSubsystemLogger } from "./subsystem-logger.js";
export type { SubsystemLogger } from "./subsystem-logger.js";
