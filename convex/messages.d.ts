export declare const appendRecord: import("convex/server").RegisteredMutation<"public", {
    customType?: string | undefined;
    type: string;
    agentId: string;
    payload: ArrayBuffer;
    sessionId: string;
}, Promise<{
    seq: number;
}>>;
export declare const readTranscript: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    agentId: string;
    sessionId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionTranscriptRecords">;
    _creationTime: number;
    customType?: string | undefined;
    seq: number;
    type: string;
    agentId: string;
    payload: ArrayBuffer;
    sessionId: string;
    createdAt: number;
}[]>>;
export declare const deleteTranscript: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    sessionId: string;
}, Promise<number>>;
export declare const inboxEnqueue: import("convex/server").RegisteredMutation<"public", {
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    sessionKey: string;
    trusted: boolean;
}, Promise<{
    seq: number;
}>>;
export declare const inboxPeek: import("convex/server").RegisteredQuery<"public", {
    sessionKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionInboxEvents">;
    _creationTime: number;
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    ts: number;
    seq: number;
    sessionKey: string;
    trusted: boolean;
}[]>>;
export declare const inboxDrain: import("convex/server").RegisteredMutation<"public", {
    sessionKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionInboxEvents">;
    _creationTime: number;
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    ts: number;
    seq: number;
    sessionKey: string;
    trusted: boolean;
}[]>>;
export declare const inboxConsumePrefix: import("convex/server").RegisteredMutation<"public", {
    sessionKey: string;
    prefixLength: number;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionInboxEvents">;
    _creationTime: number;
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    ts: number;
    seq: number;
    sessionKey: string;
    trusted: boolean;
}[]>>;
export declare const inboxHasEvents: import("convex/server").RegisteredQuery<"public", {
    sessionKey: string;
}, Promise<boolean>>;
//# sourceMappingURL=messages.d.ts.map