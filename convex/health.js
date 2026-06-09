// convex/health.ts
//
// Convex-side liveness probe. ConvexBrigadeStore.healthcheck() calls this
// from filesystem-mode boot to confirm the backend is reachable + the
// schema is deployed. Returns the schema version + the number of seeded
// brigadeConfig rows so a freshly-deployed-but-empty backend reports
// distinctly from a populated one.
import { query } from "./_generated/server.js";
export const ping = query({
    args: {},
    handler: async (ctx) => {
        const configRows = await ctx.db.query("brigadeConfig").take(1);
        return {
            ok: true,
            schemaVersion: 2,
            hasConfig: configRows.length > 0,
            now: Date.now(),
        };
    },
});
//# sourceMappingURL=health.js.map