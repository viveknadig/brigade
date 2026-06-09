export declare const list: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"skills">;
    _creationTime: number;
    ownerId: string;
    name: string;
    source: "workspace" | "managed" | "bundled" | "project" | "config" | "personal";
    description: string;
    agentId: string | null;
    createdAt: number;
    updatedAt: number;
    frontmatter: string;
    body: string;
    eligibility: {
        os: string[];
        requiresBins: string[];
        requiresAnyBins: string[];
        requiresEnv: string[];
        requiresConfig: string[];
    };
    disableModelInvocation: boolean;
}[]>>;
export declare const get: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
    name: string;
}, Promise<{
    _id: import("convex/values").GenericId<"skills">;
    _creationTime: number;
    ownerId: string;
    name: string;
    source: "workspace" | "managed" | "bundled" | "project" | "config" | "personal";
    description: string;
    agentId: string | null;
    createdAt: number;
    updatedAt: number;
    frontmatter: string;
    body: string;
    eligibility: {
        os: string[];
        requiresBins: string[];
        requiresAnyBins: string[];
        requiresEnv: string[];
        requiresConfig: string[];
    };
    disableModelInvocation: boolean;
} | null>>;
export declare const upsert: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    name: string;
    source: "workspace" | "managed" | "bundled" | "project" | "config" | "personal";
    description: string;
    agentId: string | null;
    frontmatter: string;
    body: string;
    eligibility: {
        os: string[];
        requiresBins: string[];
        requiresAnyBins: string[];
        requiresEnv: string[];
        requiresConfig: string[];
    };
    disableModelInvocation: boolean;
}, Promise<{
    created: boolean;
}>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    name: string;
}, Promise<boolean>>;
//# sourceMappingURL=skills.d.ts.map