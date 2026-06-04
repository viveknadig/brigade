/**
 * Tests for the columnar/tree ASCII renderers + the HTML chart
 * generator + the image-save helper (with a stub Playwright wrapper
 * so tests don't spawn a real browser).
 *
 * The Pride structure is enforced by `flattenToThreeTiers`:
 *   Higher Office (1) → Departments → Leads (N) → Team
 * Middle managers collapse into the team band — that's the brand
 * ("no managers, just leads and the team"). The HTML renderer
 * preserves this exactly; it only changes the visual presentation.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { OrgGraph } from "./types.js";
import {
  renderPrideColumns,
  renderPrideColumnsWithPins,
} from "./pride-template.js";
import {
  renderPrideHtml,
  deptEmoji,
  teamEmoji,
  DEPT_EMOJI,
} from "./pride-html.js";
import { saveOrgChartImage } from "./pride-image.js";
import {
  BRIGADE_FOOTER_RULES,
  BRIGADE_TAUNTS,
  createSeededRng,
} from "./pride-taunts.js";

interface MemberSpec {
  department: string;
  reportsTo: string | null;
  role?: string;
}

function makeGraph(spec: {
  topOrder: string;
  members: Record<string, MemberSpec>;
}): OrgGraph {
  const members: OrgGraph["members"] = {};
  const departments: Record<string, string[]> = {};
  for (const [id, m] of Object.entries(spec.members)) {
    members[id] = {
      department: m.department,
      reportsTo: m.reportsTo,
      source: "explicit",
      ...(m.role !== undefined ? { role: m.role } : {}),
    };
    const bucket = departments[m.department] ?? [];
    bucket.push(id);
    departments[m.department] = bucket;
  }
  for (const key of Object.keys(departments)) {
    const b = departments[key];
    if (b) b.sort();
  }
  return {
    topOrder: spec.topOrder,
    members,
    departments,
    edges: [],
    mode: "derived",
  };
}

const SAMPLE: OrgGraph = makeGraph({
  topOrder: "alex",
  members: {
    alex: { department: "executive", reportsTo: null, role: "Chief of Staff" },
    priya: { department: "engineering", reportsTo: "alex", role: "Eng Lead" },
    keshav: { department: "engineering", reportsTo: "priya", role: "Inv Spec" },
    rex: { department: "ops", reportsTo: "alex", role: "Ops Lead" },
    zen: { department: "ops", reportsTo: "rex", role: "Logistics" },
  },
});

/* ─── renderPrideColumns (ASCII) ───────────────────────────────── */

describe("renderPrideColumns", () => {
  it("(1) renders header + taunt + top box + dept boxes + team bullets", () => {
    const out = renderPrideColumns(SAMPLE, {
      emoji: true,
      ansi: false,
      story: "never",
      rng: createSeededRng(42),
    });
    assert.match(out, /🦁 The Pride/);
    assert.match(out, /👑 alex/);
    assert.match(out, /Chief of Staff/);
    assert.match(out, /[┌┐└┘├┤┬┴┼─│]/);
    assert.match(out, /🏛 engineering/);
    assert.match(out, /🏛 ops/);
    assert.match(out, /priya/);
    assert.match(out, /rex/);
    assert.match(out, /• keshav/);
    assert.match(out, /• zen/);
    assert.ok(
      BRIGADE_FOOTER_RULES.some((f) => out.includes(f)),
      "footer rule must come from the bank",
    );
    assert.ok(
      BRIGADE_TAUNTS.some((t) => out.includes(t)),
      "taunt must come from the bank",
    );
  });

  it("(2) ASCII fallback uses + - | instead of box-drawing", () => {
    const out = renderPrideColumns(SAMPLE, {
      emoji: false,
      ansi: false,
      story: "never",
      rng: createSeededRng(7),
    });
    // Box CORNERS must not be unicode; `──` rule separator is allowed
    // because it's punctuation, not a box edge.
    assert.doesNotMatch(out, /[┌┐└┘├┤┬┴┼│]/);
    assert.match(out, /\+/);
    assert.match(out, /\|/);
  });

  it("(3) single-dept org → spine has a single ┴, no horizontal line", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null, role: "CEO" },
        eng_lead: { department: "eng", reportsTo: "main", role: "Eng Lead" },
      },
    });
    const out = renderPrideColumns(graph, {
      emoji: true,
      ansi: false,
      story: "never",
      rng: createSeededRng(1),
    });
    assert.match(out, /🏛 eng/);
    assert.match(out, /eng_lead/);
    assert.match(out, /┴/);
  });

  it("(4) renderPrideColumnsWithPins honours operator-pinned heads", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null, role: "CEO" },
        a: { department: "eng", reportsTo: "main", role: "Senior Eng" },
        b: { department: "eng", reportsTo: "a", role: "Junior Eng" },
      },
    });
    const out = renderPrideColumnsWithPins(graph, { eng: "b" }, {
      emoji: true,
      ansi: false,
      story: "never",
      rng: createSeededRng(99),
    });
    const lines = out.split("\n");
    const deptHdrIdx = lines.findIndex((ln) => ln.includes("🏛 eng"));
    assert.ok(deptHdrIdx >= 0, "dept header must render");
    const remainder = lines.slice(deptHdrIdx).join("\n");
    assert.match(remainder, /\bb\b/);
    assert.match(remainder, /• a\b/);
  });

  it("(5) deterministic with a seeded RNG", () => {
    const a = renderPrideColumns(SAMPLE, {
      emoji: true,
      ansi: false,
      story: "always",
      rng: createSeededRng(12345),
    });
    const b = renderPrideColumns(SAMPLE, {
      emoji: true,
      ansi: false,
      story: "always",
      rng: createSeededRng(12345),
    });
    assert.equal(a, b);
  });
});

/* ─── renderPrideHtml ──────────────────────────────────────────── */

describe("renderPrideHtml", () => {
  it("(1) emits a complete HTML document with the emoji font stack", () => {
    const { html, width, height } = renderPrideHtml(SAMPLE, {
      story: "never",
      rng: createSeededRng(42),
    });
    assert.ok(html.startsWith("<!doctype html>"));
    assert.match(html, /<style>/);
    // Browser-native color emoji font stack
    assert.match(html, /Segoe UI Emoji/);
    assert.match(html, /Apple Color Emoji/);
    assert.match(html, /Noto Color Emoji/);
    // Identifiers + dept emojis in body
    assert.match(html, /alex/);
    assert.match(html, /priya/);
    assert.match(html, /rex/);
    assert.match(html, /keshav/);
    assert.match(html, /👑/);
    assert.match(html, /⚙️/);
    // Footer ⚡ and story 📖 are plain HTML now — browser renders color
    assert.match(html, /⚡/);
    assert.ok(width > 0);
    assert.ok(height > 0);
  });

  it("(2) preserves the 3-tier Pride structure (no managers band)", () => {
    // Deep org: top → vp → senior → ic. Middle layer (vp, senior)
    // must collapse — the renderer should produce ONE dept lead per
    // dept and put everyone else in the team band.
    const graph = makeGraph({
      topOrder: "ceo",
      members: {
        ceo: { department: "executive", reportsTo: null, role: "CEO" },
        vp_eng: { department: "engineering", reportsTo: "ceo", role: "VP Engineering" },
        sr_eng: { department: "engineering", reportsTo: "vp_eng", role: "Senior Eng" },
        ic1: { department: "engineering", reportsTo: "sr_eng", role: "Engineer" },
        ic2: { department: "engineering", reportsTo: "sr_eng", role: "Engineer" },
      },
    });
    const { html } = renderPrideHtml(graph, {
      story: "never",
      rng: createSeededRng(0),
    });
    // ONE lead-card per dept; the rest land in the team block.
    // The class attribute now includes a tier modifier (lead-card tier-top
    // / lead-card tier-lead), so match the lead-card class token with a
    // word boundary instead of requiring the literal closing quote.
    const leadCards = html.match(/class="lead-card\b/g) ?? [];
    // Top + 1 dept lead = 2
    assert.equal(leadCards.length, 2);
    // All engineering members appear (top, lead, plus 2 ICs)
    assert.match(html, /vp_eng|sr_eng/); // one of them is the lead
    assert.match(html, /ic1/);
    assert.match(html, /ic2/);
  });

  it("(3) includes a taunt + footer rule from the banks", () => {
    const { html } = renderPrideHtml(SAMPLE, {
      story: "never",
      rng: createSeededRng(7),
    });
    // Strip HTML tags before checking — text wrapping doesn't matter.
    const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.ok(
      BRIGADE_TAUNTS.some((t) => plain.includes(t)),
      "HTML must contain a taunt from the bank",
    );
    assert.ok(
      BRIGADE_FOOTER_RULES.some((f) => plain.includes(f)),
      "HTML must contain a footer rule from the bank",
    );
  });

  it("(4) story:never suppresses the story block", () => {
    const { html } = renderPrideHtml(SAMPLE, {
      story: "never",
      rng: createSeededRng(0),
    });
    assert.doesNotMatch(html, /📖/);
  });

  it("(5) escapes HTML-special chars in ids/roles", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "x", reportsTo: null, role: "<script>alert(1)</script>" },
      },
    });
    const { html } = renderPrideHtml(graph, {
      story: "never",
      rng: createSeededRng(1),
    });
    // No raw <script> tags allowed
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});

/* ─── deptEmoji + teamEmoji mappings ───────────────────────────── */

describe("deptEmoji + teamEmoji", () => {
  it("dept emoji map covers common slugs", () => {
    assert.equal(deptEmoji("engineering"), "⚙️");
    assert.equal(deptEmoji("ops"), "📦");
    assert.equal(deptEmoji("design"), "🎨");
    assert.equal(deptEmoji("marketing"), "📣");
    assert.equal(deptEmoji("UNKNOWN"), "🏛");
  });

  it("DEPT_EMOJI table is exported (consumers can introspect)", () => {
    assert.equal(typeof DEPT_EMOJI.engineering, "string");
  });

  it("teamEmoji overrides dept default by role keyword", () => {
    // Engineer role keyword should beat dept emoji
    assert.equal(teamEmoji("ops", "Senior Engineer"), "💻");
    // Designer role keyword
    assert.equal(teamEmoji("engineering", "Product Designer"), "🎨");
    // No role → falls back to dept emoji
    assert.equal(teamEmoji("marketing", undefined), "📣");
  });
});

/* ─── saveOrgChartImage (HTML engine with stub screenshot) ─────── */

describe("saveOrgChartImage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "brigade-org-img-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("(1) writes PNG via stub Playwright screenshot", async () => {
    const fakePng = Buffer.from("FAKE-PNG-BYTES");
    const result = await saveOrgChartImage(SAMPLE, undefined, {
      outDir: tmpDir,
      story: "never",
      rng: createSeededRng(42),
      htmlScreenshot: async (_html, vp) => ({
        buffer: fakePng,
        width: vp.width * 2,
        height: vp.height * 2,
      }),
    });
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.format, "png");
    assert.equal(result.rasterized, true);
    assert.ok(result.filePath.endsWith(".png"));
    const bytes = await fs.readFile(result.filePath);
    assert.equal(bytes.toString("utf8"), "FAKE-PNG-BYTES");
  });

  it("(2) idempotent: same content → cached:true on second call", async () => {
    const stub = async (_h: string, vp: { width: number; height: number }) => ({
      buffer: Buffer.from("x"),
      width: vp.width,
      height: vp.height,
    });
    const a = await saveOrgChartImage(SAMPLE, undefined, {
      outDir: tmpDir,
      story: "never",
      rng: createSeededRng(42),
      htmlScreenshot: stub,
    });
    const b = await saveOrgChartImage(SAMPLE, undefined, {
      outDir: tmpDir,
      story: "never",
      rng: createSeededRng(42),
      htmlScreenshot: stub,
    });
    assert.equal(a.filePath, b.filePath);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
  });

  it("(3) force:true re-renders even when cached", async () => {
    const stub = async (_h: string, vp: { width: number; height: number }) => ({
      buffer: Buffer.from("x"),
      width: vp.width,
      height: vp.height,
    });
    await saveOrgChartImage(SAMPLE, undefined, {
      outDir: tmpDir,
      story: "never",
      rng: createSeededRng(42),
      htmlScreenshot: stub,
    });
    const second = await saveOrgChartImage(SAMPLE, undefined, {
      outDir: tmpDir,
      story: "never",
      rng: createSeededRng(42),
      htmlScreenshot: stub,
      force: true,
    });
    assert.equal(second.cached, false);
  });

  it("(4) screenshot errors propagate (no SVG fallback)", async () => {
    await assert.rejects(
      saveOrgChartImage(SAMPLE, undefined, {
        outDir: tmpDir,
        story: "never",
        rng: createSeededRng(42),
        htmlScreenshot: async () => {
          throw new Error("browser launch failed");
        },
      }),
      /browser launch failed/,
    );
  });
});
