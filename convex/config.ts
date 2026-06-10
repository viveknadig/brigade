// convex/config.ts
//
// Convex functions for the brigadeConfig table — one row per operator
// (keyed by instanceId). Mirrors LocalConfigStore's surface so the
// adapter can call these and look identical to filesystem callers.
//
// `read` returns the single config row (or null on first boot).
// `write` is an upsert with optimistic-concurrency support via the
// `expectedSha256` arg — when supplied, the mutation refuses to write
// if the on-disk content hash has drifted.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const read = query({
	args: { instanceId: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("brigadeConfig")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		return row;
	},
});

export const write = mutation({
	args: {
		instanceId: v.string(),
		agents:   v.optional(v.any()),
		gateway:  v.optional(v.any()),
		session:  v.optional(v.any()),
		tools:    v.optional(v.any()),
		auth:     v.optional(v.any()),
		plugins:  v.optional(v.any()),
		skills:   v.optional(v.any()),
		channels: v.optional(v.any()),
		bindings: v.optional(v.any()),
		org:      v.optional(v.any()),
		wizard:   v.optional(v.any()),
		meta:     v.optional(v.any()),
		defaults: v.optional(v.any()),
		extra:    v.optional(v.any()),
		contentSha256: v.string(),
		bytes: v.number(),
		expectedSha256: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("brigadeConfig")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		if (
			args.expectedSha256 !== undefined &&
			existing &&
			existing.contentSha256 !== args.expectedSha256
		) {
			throw new Error(
				`OCC conflict: expected sha256=${args.expectedSha256} but on-disk is ${existing.contentSha256}`,
			);
		}
		const payload = {
			instanceId: args.instanceId,
			schemaVersion: 2 as const,
			agents:   args.agents,
			gateway:  args.gateway,
			session:  args.session,
			tools:    args.tools,
			auth:     args.auth,
			plugins:  args.plugins,
			skills:   args.skills,
			channels: args.channels,
			bindings: args.bindings,
			org:      args.org,
			wizard:   args.wizard,
			meta:     args.meta,
			defaults: args.defaults,
			extra:    args.extra,
			contentSha256: args.contentSha256,
			bytes: args.bytes,
			updatedAtMs: Date.now(),
		};
		if (existing) {
			await ctx.db.replace(existing._id, payload);
			return { rev: args.contentSha256, updated: true };
		}
		await ctx.db.insert("brigadeConfig", payload);
		return { rev: args.contentSha256, updated: false };
	},
});
