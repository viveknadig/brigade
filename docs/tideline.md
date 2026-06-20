# 🌊 Tideline — Brigade's long-term memory engine

Tideline is the long-term memory framework that backs Brigade. It is a
**model-agnostic memory engine** — it works with zero embedding model, learns from
one if you give it, and is designed to be lifted out of Brigade and published on its
own (`brigade-tideline`).

Where a transcript is what an agent *just said*, Tideline is what an agent *knows*:
durable facts about you and your work, written under a trust gate, recalled by
meaning, decayed when stale, and reconciled over time.

> TL;DR — append-only facts with origin scoping, a poisoning-resistant write gate,
> hybrid keyword+vector recall that needs no model to run, bi-temporal decay folded
> into one score, a typed link graph, and a nightly reflect/consolidate pass. One
> `Tideline` facade; a small adapter SPI underneath.

---

## Why it exists

Most "agent memory" is a vector store with a similarity search bolted on. That
breaks in three ways Tideline is built to survive:

1. **Poisoning.** A web page or a tool result should never be able to rewrite "the
   operator is vegetarian." Tideline's **write-gate** refuses untrusted sources from
   authoring or superseding protected facts.
2. **Privacy bleed.** In a multi-channel crew, a WhatsApp peer's facts must never
   surface in the operator's recall. Tideline scopes every record by **origin**.
3. **Staleness & contradiction.** Beliefs change. Tideline **decays** unused facts,
   detects **contradictions**, and **consolidates** repeated beliefs instead of
   piling up duplicates.

And it does all of this **without requiring an embedding model** — recall runs on a
BM25-primary lane with a model-free vector *recovery* lane, so it works offline and
air-gapped out of the box. A learned embedder is an optional upgrade, never a
dependency.

---

## The record model

Every memory is a structured record, not a raw chunk:

| Field | Meaning |
|---|---|
| `content` | the fact, in natural language |
| `segment` | `identity` · `preference` · `correction` · `relationship` · `project` · `knowledge` · `context` |
| `tier` | `short` · `long` · `permanent` (permanent never decays) |
| `importance` | 0–1, modulates decay and ranking |
| `origin` | `owner`, or `channel + conversationId + sessionKey` |
| `lifecycle` | `active` → `archived` → `pruned` |
| `links` | typed edges to other records (see the graph below) |

Segment defaults (`SEGMENT_DEFAULTS`) seed sensible tier/importance per segment —
`identity` and `correction` are protected and long-lived; `context` is short.

---

## End to end: the three flows

### 1. Write — gated and deduped

```
add(fact) ──▶ write-gate ──▶ same-origin dedup ──▶ FactStore (append-only JSONL)
              │
              └─ rejects an UNTRUSTED source (tool_output, retrieved_document,
                 extraction, compaction) trying to author/supersede a PROTECTED
                 segment (identity/preference/correction) → throws WriteGateError
```

The **write-gate** (`evaluateWriteGate`) classifies the *source* (trusted:
`user_instruction`, `owner_message`; untrusted: everything else) and the *target
segment*. Untrusted writes into protected segments are blocked; untrusted writes
elsewhere are **confined** (kept, but not allowed to overwrite trusted beliefs).
Dedup is **same-origin only** — it never merges across principals.

### 2. Recall — hybrid, ranked, origin-scoped, budgeted

```
query ─▶ BM25 (tokenize + bm25Score) ─┐
        HRR vector recovery (cosine) ─┼▶ graph walk ─▶ effectiveScore ─▶ origin
                                       │   (typed links)   (decay × trust)   filter
                                       └────────────────────────────────────────┘
                                                            │
                                          ranked hits ──▶ context() budget block
```

- **Hybrid lane** (`recallHybrid`) runs BM25 as the primary signal and a **model-free
  HRR** vector lane as recovery, so semantically-close phrasings still match without
  an embedding model. Swap in a learned embedder (`OpenAiEmbedder`, or your own) to
  upgrade the vector lane.
- **Graph recall** (`recallWithGraph`) expands hits along typed links, so recalling
  one fact pulls in what it `supports` / `relates` to / `supersedes`.
- **`effectiveScore`** folds bi-temporal **decay** (recency + usage) and
  **source-trust** weighting into a single ranking number.
- The result is filtered by the **current call's origin** *before* anything is
  returned, then `context()` packs the top facts into a character-budgeted block
  ready to drop into a prompt.

### 3. Maintain — decay, dream, reconcile

- **Decay GC** (`runDecayGc`) archives then prunes neglected facts; `permanent` is
  immune, confirmed facts resist eviction.
- **Dream** (`runDream`) is the nightly reflect/consolidate/relate pass: it confirms
  repeated beliefs, merges duplicates, writes `relates` association edges, and evicts
  decayed noise.
- **Contradiction detection** (`findContradictions`) surfaces facts that disagree so
  a correction can supersede the stale one.

---

## The typed link graph

Facts aren't an undifferentiated bag — they're a graph with **typed edges**:

`supersedes` · `transition` · `corrects` · `relates` · `derived_from` · `supports` ·
`contradicts`

This is what lets memory *evolve*: a correction `supersedes` the old belief, a
project fact `supports` a preference, an entity rename is a `transition`. The graph
powers graph-recall, contradiction handling, and the **Memory Graph dashboard
export** (`exportMemoryGraph` → nodes, typed edges, topic clusters via deterministic
community detection, and headline stats).

---

## The facade & adapter SPI

Everything above is reached through one object:

```ts
import { Tideline } from "brigade-tideline";

const memory = Tideline.open("/path/to/workspace");

memory.add({ content: "I keep a strict vegetarian diet.", segment: "preference" });
const hits  = memory.recall("what do I eat");
const block = memory.context("dietary restrictions", { maxChars: 800 });
```

Facade verbs: **`add`**, **`recall`** / `search`, **`explain`** (why a fact ranked),
**`context`** (budgeted prompt block), **`feedback`** (reinforce/penalize), and the
governance verbs **`purge`** / **`inspect`** / **`export`**.

Tideline takes a small **adapter SPI** so you can host it your way:

| Adapter | Injected via | Purpose | v1 default |
|---|---|---|---|
| `StorageAdapter` | `Tideline.over(store)` | persistence backend | bundled `FactStore` (JSONL) |
| `ClockAdapter` | `open`/`over` opt | injectable time | system clock |
| `ThreatScanAdapter` | `open`/`over` opt | recall-time content-safety scan | no-op (escape only) |
| `EmbedderAdapter` | `open`/`over` opt | learned-embedder seam — **v1: RESERVED** | model-free HRR |
| `LlmAdapter` | `open`/`over` opt | reflection/synthesis LLM — **v1: RESERVED** | none |

```ts
import { Tideline, FactStore } from "brigade-tideline";

const memory = Tideline.over(new FactStore(dir), {
  threatScan: { scan: (content) => myInjectionScanner(content) },
});
```

The power-user surface (`brigade-tideline/advanced`) exposes the passes directly —
`runDream`, `runDecayGc`, `effectiveScore`, the link graph (`buildGraph` /
`neighbors` / `spread`), governance (`purge` / `applyRetention` / `inspect` /
`exportMemory`), the write-gate (`evaluateWriteGate`), the transparency
`MemoryEventLog`, and the human-gated self-improving loop.

---

## Governance, transparency & self-improvement

- **Governance** — `purge` (cascade delete with link cleanup), `applyRetention`
  (policy-driven eviction), `inspect` (provenance of a single fact), `exportMemory`.
  Brigade surfaces these owner-only through the `manage_memory` tool (including
  crypto-shred).
- **Transparency** — `MemoryEventLog` is an append-only record of every memory
  mutation, so "why does it think that?" is always answerable.
- **Self-improving loop** — a *human-gated* cycle: `proposeFromTelemetry` →
  `gateOnEval` (must beat the eval bar) → `approve` → `applyProposal` →
  `revertProposal`. No change to recall behavior ships without passing evaluation and
  a human approval.

---

## Measuring it (the eval harness)

`brigade-tideline/eval` is a deterministic evaluation harness — gold sets,
**recall@k / MRR / nDCG@k** with bootstrap confidence intervals, and baseline +
competitor capabilities for head-to-head comparison.

```ts
import { FactStore } from "brigade-tideline";
import { seedGold, RICH_GOLD, runRecallEval, hybridRecallCapability } from "brigade-tideline/eval";

const store  = new FactStore(tmpDir);
const cases  = seedGold(store, RICH_GOLD);
const result = await runRecallEval(hybridRecallCapability(store), cases, { k: 3 });
console.log(result.recallAtK, result.mrr, result.ndcgAtK);
```

You can also measure on **your own data** without it leaving the machine: export a
gold scaffold from your real facts, rewrite each auto-query into a realistic
paraphrase, mark it `approved`, and run. `loadGoldSpec` **refuses** an un-approved
scaffold — the human rewrite is what makes it an honest measurement, not a
self-matching inflation.

Run Brigade's bundled benchmarks with `npm run bench`.

---

## How Brigade uses Tideline

- **Tools:** `write_memory` (gated add), `recall_memory` / `read_memory` (hybrid
  search across facts + `MEMORY.md` / `memory/*.md`), `manage_memory` (owner-only
  governance: dream, shred, inspect, export, retention).
- **Auto-recall:** before each turn Brigade injects an origin-matched, budgeted
  context block — and **fails closed** for unknown non-owner peers, so operator
  memory never leaks into a stranger's session.
- **Backend:** the default is the filesystem `FactStore` (append-only JSONL, safe for
  single-operator). In Convex storage mode the same records persist through the
  storage seam.

---

## Packaging status

`src/tideline/` is the **in-repo extraction layer**: it freezes the package boundary,
the public API, and the manifest, re-exported on top of the implementation in
`src/agents/memory/*` without modifying it. The facade and the pure core (scoring /
links / decay / hybrid / graph / embedder) are already host-import-free; the only
host coupling left is a **single seam module** (`agents/memory/host-ports.ts`)
bridging four Brigade subsystems (logger, Convex write-through cache, storage-mode
probe, write-time threat-scan).

A standalone `npm install brigade-tideline` needs one more step: a build script that
vendors the core and swaps `host-ports.ts` → the included `host-ports.standalone.ts`
(a complete, filesystem-only binding). Until that script exists, treat this as an
in-repo layer, not yet a published package. The provenance write-gate and the
recall-time threat-scan stay fully active in the standalone binding.

---

## See also

- Package manifest & quick reference: [`src/tideline/README.md`](../src/tideline/README.md)
- Public API surface: [`src/tideline/index.ts`](../src/tideline/index.ts) ·
  advanced: [`src/tideline/advanced.ts`](../src/tideline/advanced.ts)
- Engine implementation: [`src/agents/memory/`](../src/agents/memory/)
- Memory in the product: [README → Features → Memory](../README.md#-memory)

_License: MIT._
