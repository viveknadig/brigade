// convex/cron.ts — cronJobs + cronRuns + cronServiceState
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const ScheduleKind = v.union(v.literal("cron"), v.literal("every"), v.literal("at"));
const RunStatus = v.union(v.literal("ok"), v.literal("error"), v.literal("skipped"));
const CreatedByKind = v.union(v.literal("owner"), v.literal("channel"), v.literal("legacy"));

export const listJobs = query({
	args: { ownerUserId: v.string(), enabledOnly: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		if (args.enabledOnly) {
			return ctx.db
				.query("cronJobs")
				.withIndex("by_owner_enabled_next", (q) =>
					q.eq("ownerUserId", args.ownerUserId).eq("enabled", true),
				)
				.collect();
		}
		return ctx.db
			.query("cronJobs")
			.withIndex("by_owner_job", (q) => q.eq("ownerUserId", args.ownerUserId))
			.collect();
	},
});

export const getJob = query({
	args: { ownerUserId: v.string(), jobId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("cronJobs")
			.withIndex("by_owner_job", (q) =>
				q.eq("ownerUserId", args.ownerUserId).eq("jobId", args.jobId),
			)
			.first();
	},
});

export const insertJob = mutation({
	args: {
		jobId: v.string(),
		ownerUserId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		enabled: v.boolean(),
		agentId: v.optional(v.string()),
		sessionKey: v.optional(v.string()),
		scheduleKind: ScheduleKind,
		scheduleExpr: v.optional(v.string()),
		scheduleTz: v.optional(v.string()),
		scheduleStaggerMs: v.optional(v.number()),
		scheduleEveryMs: v.optional(v.number()),
		scheduleAnchorMs: v.optional(v.number()),
		scheduleAt: v.optional(v.number()),
		sessionTarget: v.string(),
		wakeMode: v.optional(v.string()),
		payload: v.bytes(),
		delivery: v.optional(v.bytes()),
		failureAlert: v.optional(v.any()),
		deleteAfterRun: v.optional(v.boolean()),
		createdByKind: CreatedByKind,
		createdByChannelId: v.optional(v.string()),
		createdByConversationId: v.optional(v.string()),
		createdByAccountId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		await ctx.db.insert("cronJobs", {
			...args,
			createdAtMs: now,
			updatedAtMs: now,
		});
	},
});

export const patchJob = mutation({
	args: { ownerUserId: v.string(), jobId: v.string(), patch: v.any() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("cronJobs")
			.withIndex("by_owner_job", (q) =>
				q.eq("ownerUserId", args.ownerUserId).eq("jobId", args.jobId),
			)
			.first();
		if (!existing) throw new Error(`cron: job ${args.jobId} not found`);
		await ctx.db.patch(existing._id, {
			...(args.patch as Record<string, unknown>),
			updatedAtMs: Date.now(),
		});
		return await ctx.db.get(existing._id);
	},
});

export const deleteJob = mutation({
	args: { ownerUserId: v.string(), jobId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("cronJobs")
			.withIndex("by_owner_job", (q) =>
				q.eq("ownerUserId", args.ownerUserId).eq("jobId", args.jobId),
			)
			.first();
		if (!existing) return false;
		await ctx.db.delete(existing._id);
		return true;
	},
});

export const markRunning = mutation({
	args: { ownerUserId: v.string(), jobId: v.string(), runningAtMs: v.number() },
	handler: async (ctx, args) => {
		const job = await ctx.db
			.query("cronJobs")
			.withIndex("by_owner_job", (q) =>
				q.eq("ownerUserId", args.ownerUserId).eq("jobId", args.jobId),
			)
			.first();
		if (!job) return false;
		if (job.stateRunningAtMs && job.stateRunningAtMs > 0) return false;
		await ctx.db.patch(job._id, { stateRunningAtMs: args.runningAtMs });
		return true;
	},
});

export const appendRunLog = mutation({
	args: {
		ownerUserId: v.string(),
		jobId: v.string(),
		ts: v.number(),
		status: RunStatus,
		error: v.optional(v.string()),
		summary: v.optional(v.bytes()),
		delivered: v.optional(v.boolean()),
		deliveryStatus: v.optional(v.string()),
		deliveryError: v.optional(v.string()),
		sessionId: v.optional(v.string()),
		sessionKey: v.optional(v.string()),
		runAtMs: v.optional(v.number()),
		durationMs: v.optional(v.number()),
		nextRunAtMs: v.optional(v.number()),
		model: v.optional(v.string()),
		provider: v.optional(v.string()),
		usageInput: v.optional(v.number()),
		usageOutput: v.optional(v.number()),
		usageCacheRead: v.optional(v.number()),
		usageCacheWrite: v.optional(v.number()),
		usageTotalTokens: v.optional(v.number()),
		usageCostUsd: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert("cronRuns", args);
	},
});

export const listRunLog = query({
	args: { ownerUserId: v.string(), jobId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit && args.limit > 0 ? args.limit : 50;
		return ctx.db
			.query("cronRuns")
			.withIndex("by_owner_job_ts", (q) =>
				q.eq("ownerUserId", args.ownerUserId).eq("jobId", args.jobId),
			)
			.order("desc")
			.take(limit);
	},
});
