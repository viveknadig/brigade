// Phase 0 of subscription-auth: the runtime credential pipeline must pass
// OAuth-login + setup-token credentials through to Pi instead of dropping them
// (Pi's AuthStorage handles {type:"oauth"} natively and value-detects an
// `sk-ant-oat…` token to switch to Bearer auth).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initAuthProfiles, upsertOAuthProfile } from "../auth/profiles.js";
import { resolveAuthProfilesPath } from "../config/paths.js";
import { readAuthProfilesAsCredentialMap } from "./agent-loop.js";

function withProfiles(profiles: Record<string, unknown>): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "brigade-credmap-"));
  const path = join(dir, "auth-profiles.json");
  writeFileSync(path, JSON.stringify({ version: 1, profiles }, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("oauth profile passes through as a Pi oauth credential (not dropped)", () => {
  const { path, cleanup } = withProfiles({
    "anthropic:default": {
      provider: "anthropic",
      type: "oauth",
      access: "sk-ant-oat01-abc",
      refresh: "ref-xyz",
      expires: 123456,
    },
  });
  try {
    const { credentials } = readAuthProfilesAsCredentialMap(path);
    assert.deepEqual(credentials.anthropic, {
      type: "oauth",
      access: "sk-ant-oat01-abc",
      refresh: "ref-xyz",
      expires: 123456,
    });
  } finally {
    cleanup();
  }
});

test("setup-token profile passes through as an api_key value", () => {
  const { path, cleanup } = withProfiles({
    "anthropic:default": {
      provider: "anthropic",
      type: "token",
      token: "sk-ant-oat01-tok",
    },
  });
  try {
    const { credentials } = readAuthProfilesAsCredentialMap(path);
    assert.deepEqual(credentials.anthropic, { type: "api_key", key: "sk-ant-oat01-tok" });
  } finally {
    cleanup();
  }
});

test("api_key profile is unchanged", () => {
  const { path, cleanup } = withProfiles({
    "openai:default": { provider: "openai", type: "api_key", key: "sk-test-123" },
  });
  try {
    const { credentials } = readAuthProfilesAsCredentialMap(path);
    assert.deepEqual(credentials.openai, { type: "api_key", key: "sk-test-123" });
  } finally {
    cleanup();
  }
});

test("ANTHROPIC_OAUTH_TOKEN env fallback surfaces when no profile exists", () => {
  const { path, cleanup } = withProfiles({});
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY; // ensure the fallback, not the primary, is exercised
  process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat01-env";
  try {
    const { credentials } = readAuthProfilesAsCredentialMap(path);
    assert.deepEqual(credentials.anthropic, { type: "api_key", key: "sk-ant-oat01-env" });
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevOauth === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
    else process.env.ANTHROPIC_OAUTH_TOKEN = prevOauth;
    cleanup();
  }
});

// End-to-end: the REAL onboarding persist (`upsertOAuthProfile`) writes a profile
// the runtime credential map reads back as a Pi oauth credential — the full
// write→read chain a subscription login exercises, not just a hand-written file.
test("end-to-end: upsertOAuthProfile → readAuthProfilesAsCredentialMap (oauth)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brigade-sub-e2e-"));
  const prev = process.env.BRIGADE_STATE_DIR;
  process.env.BRIGADE_STATE_DIR = dir;
  try {
    initAuthProfiles("main");
    upsertOAuthProfile("main", {
      provider: "github-copilot",
      access: "sk-cop-live",
      refresh: "r1",
      expires: 999,
    });
    const { credentials } = readAuthProfilesAsCredentialMap(
      resolveAuthProfilesPath("main"),
      undefined,
      "main",
    );
    assert.deepEqual(credentials["github-copilot"], {
      type: "oauth",
      access: "sk-cop-live",
      refresh: "r1",
      expires: 999,
    });
  } finally {
    if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
    else process.env.BRIGADE_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
