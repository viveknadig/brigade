// convex/sessions.ts — sessions index
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
const Subagent = v.object({
    spawnDepth: v.number(),
    spawnedBy: v.string(),
    parentRunId: v.optional(v.string()),
    label: v.optional(v.string()),
    cleanup: v.optional(v.union(v.literal("delete"), v.literal("keep"))),
    spawnedAt: v.string(),
    spawnedWorkspaceDir: v.optional(v.string()),
});
export const getEntry = query({
    args: { agentId: v.string(), sessionKey: v.string() },
    handler: async (ctx, args) => {
        return ctx.db
            .query("sessions")
            .withIndex("by_agent_key", (q) => q.eq("agentId", args.agentId).eq("sessionKey", args.sessionKey))
            .first();
    },
});
export const listEntries = query({
    args: { agentId: v.string(), subagentOnly: v.optional(v.boolean()) },
    handler: async (ctx, args) => {
        const all = await ctx.db
            .query("sessions")
            .withIndex("by_agent_lastUsed", (q) => q.eq("agentId", args.agentId))
            .order("desc")
            .collect();
        if (args.subagentOnly)
            return all.filter((s) => s.subagent !== undefined);
        return all;
    },
});
export const upsertEntry = mutation({
    args: {
        agentId: v.string(),
        sessionKey: v.string(),
        sessionId: v.string(),
        createdAt: v.optional(v.number()),
        lastUsedAt: v.optional(v.number()),
        provider: v.optional(v.string()),
        modelId: v.optional(v.string()),
        authProfile: v.optional(v.string()),
        thinkingLevel: v.optional(v.string()),
        subagent: v.optional(Subagent),
        extra: v.optional(v.bytes()),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("sessions")
            .withIndex("by_agent_key", (q) => q.eq("agentId", args.agentId).eq("sessionKey", args.sessionKey))
            .first();
        const now = Date.now();
        const payload = {
            ...args,
            createdAt: args.createdAt ?? now,
            lastUsedAt: args.lastUsedAt ?? now,
        };
        if (existing) {
            await ctx.db.replace(existing._id, payload);
            return await ctx.db.get(existing._id);
        }
        const id = await ctx.db.insert("sessions", payload);
        return await ctx.db.get(id);
    },
});
export const deleteEntry = mutation({
    args: { agentId: v.string(), sessionKey: v.string() },
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("sessions")
            .withIndex("by_agent_key", (q) => q.eq("agentId", args.agentId).eq("sessionKey", args.sessionKey))
            .first();
        if (!existing)
            return false;
        await ctx.db.delete(existing._id);
        return true;
    },
});
//# sourceMappingURL=sessions.js.map