# Returning Speck's components to the default path

Since 2026-10-20 Speck's default path is the model's ordinary chat. The plain
model is the floor: a turn no component acts on is sent exactly as the model
would receive it on its own. The restore point is the tag
`baseline/default-path-2026-10-21`.

Speck's other parts come back one at a time, as **components**
(`src/speck/component.ts`). Each has three optional steps:

- **observe**: read the message and update the component's own state;
- **contribute**: add a section of notes;
- **review**: replace the reply, giving a reason.

A component is on the path only once admitted (`src/speck/components/index.ts`).
Until then it is a candidate.

## The gate (no harm, then gain)

Run `recovery/2026-10-20-reader/harness/gate.mjs <candidate> <out> --domain <set.mjs>`.

It runs every conversation twice:

- **S0**: the admitted components;
- **S1**: S0 plus the candidate.

Both use the same response cache, so they replay identically wherever the candidate does nothing. The gate takes seconds when cached and minutes when live.

| Set | What it is for |
|---|---|
| varied-set/1 (18 conversations) | shared no-harm set: general, follow-up, correction, rule tasks |
| smoke/1 (11 conversations) | shared no-harm set on development seeds |
| the candidate's domain set | written **before** the candidate is built, from what the archived part was for. It includes turns the candidate must leave alone |

**Admission**: a candidate is admitted when all three hold.

1. No probe S0 passes is failed by S1. Every probe whose result changed is read by hand.
2. On the shared sets, every turn the candidate touched is read by hand, and none is a turn it had no business touching.
3. On its domain set, it does what it is for, without losing a probe S0 passes.

A gain claimed against the plain model still needs a blind run on a fresh seed, with the user's approval first.

Harness copies, domain sets and their hashes are in `docs/reintegration/`. Gate results are recorded below, one row per run, including failures. A candidate that fails stays a candidate, or goes back to `failed work/` with its result.

## Supporting machinery: test a component with what could support it (2026-10-22)

Until now every candidate was gated on the bare default path. A component that only works with Speck's supporting machinery would fail unfairly.

The supporting machinery:

- the context engine and working-memory competition;
- activation-based recall: the ACA graph, reinforcement and decay;
- belief revision;
- the prediction loop;
- metacognition: calibration and competence;
- procedures and known answers;
- background maintenance: consolidation and decay between sessions.

So, from now on:

1. **Each candidate names the machinery that could support it** (the table below) before its gate runs.
2. **The gate runs a third arm when there is any:** S2 = S1 plus that machinery switched on. It is reported beside S0 and S1, so a component can be judged on its own and with its support. Each piece of machinery is attributed by ablation: remove one piece at a time, in paired runs.
3. **Components already gated without support are reconsidered against the table.** Any whose failure the machinery could plausibly address is re-gated with S2 before it is written off.
4. **Long-horizon sets.** Machinery whose value is long-horizon (activation, consolidation, calibration) needs test sets of many sessions and turns; the short shared sets cannot show it.

| Component | Status | Machinery that could support it |
|---|---|---|
| `rule` | admitted | belief revision (rules as hypotheses), metacognition |
| `memory` | admitted | activation-based recall and reinforcement, background consolidation and decay |
| `files` | admitted | prediction loop (tool outcomes), metacognition (routing competence) |
| `claims` | not admitted | belief revision, a qualified checker (blocked) |
| `planning` | not admitted | coordination, prediction loop |
| `amounts` / `ledger` | not admitted / pending | belief revision over updates, working-memory competition |
| `hypotheses`, `checks` | blocked | the qualified checker, belief revision, metacognition |

**Current priority (the user's, 2026-10-22): the checker path first.** It unblocks hypotheses and checks, and through them belief revision, which supports several components above.

## Switches (cognition vs. features)

A component that improves answers has no switch and is always on.

A component that adds time or a feature without improving answers declares an `option` (label, what it adds, measured cost, default). It gets a switch under **System → Cognition → Speck components**, saved in the interface state and applied from the next message.

| Component | Switch | Default | Measured cost |
|---|---|---|---|
| `rule` | none (improves answers) | always on | one reader call on messages with a mapping symbol |
| `memory` | Memory across conversations | on | about 0.1–0.4 s per message |
| `files` | Read workspace files | on | about 5–8 s per message |
| `pages` | Read web pages you name | on | about 5–8 s per message to decide, plus the page load |

## Order

Capabilities the plain model cannot have come first. Parts that were measured to do harm come last, and only as notes or reviews, never as routing.

| # | Component | From | What it adds | Domain set must show |
|---|---|---|---|---|
| 1 | `rule`: rule learning and application | `cognition/induction*`, `example-support` | **admitted 2026-10-20** | — |
| 2 | `memory`: facts the user states, remembered across conversations | `controller/facts.ts`, `memory/grounding.ts`, shared memory, `memory/recall.ts` | Notes listing the facts from earlier conversations that bear on the message | Recall in a later session. Retention respected ("don't keep this"). Unrelated questions untouched. No invented facts |
| 3 | `tools`: read-only tools (`files` admitted 2026-10-21; web and document search pending) | `controller/tool-step.ts`, `cognition/toolbelt.ts`, Tool Caller, `tools/*` | A tool's result as notes when a tool must act (time, workspace files, web) | The tool used when needed. No tool on ordinary questions. Approval kept for risky tools |
| 4 | `claims`: claims in a reply checked against Speck's state (**gated 2026-10-21: not admitted**) | `cognition/claims.ts`, `reply-grounding.ts` | Review of replies against rule and memory state | Wrong claims turned back. Right ones untouched |
| 5 | `threads`: earlier topics (**not ported 2026-10-21**: built on word lists; see below) | `cognition/segmentation.ts` (episodes measured harmful as routing) | Notes when a message returns to an earlier thread | Return to a topic after an interruption. No change to follow-ups |
| 6 | `hypotheses`: non-rule hypotheses on demand (checker qualified 2026-10-22; **gated: not admitted**) | `controller/hypotheses.ts`, `task-evidence.ts` | Notes on hypotheses checked against the user's messages | Diagnosis-style conversations |
| 7 | `planning`: multi-step requests (**gated 2026-10-21: not admitted**) | `controller/planning.ts` | Notes of a decomposition | Multi-step tasks. Single-step ones untouched |
| 8 | `checks`: qualified checkers (checker qualified 2026-10-22; the reply check was gated as `hypotheses`, not admitted. The archived completion and waiting validators judged the pipeline's task states, which the default path does not have) | `controller/validators.ts`, `metacognition/qualification.ts` | Review by qualified judgment classes only | Measured qualification per class |

Supporting parts (metacognition: competence, calibration, qualification; belief revision; memory graph and activation) return with the first component that needs them, and are measured through it.

`controller/intake.ts` (routing by turn class) is not planned: the default path replaces routing.

## Gate results

| Date | Candidate | Shared: S0 → S1 (losses, gains, turns touched) | Domain | Decision |
|---|---|---|---|---|
| 2026-10-21 | `rule` (self-test of the gate; S0 = plain) | varied 23→23/28 (0, 0, 19/45); smoke 23→26/27 (0, 3, 18/60) | — | gate reproduces A vs S; already admitted |
| 2026-10-21 | `memory`, first run | varied 23→23 (0, 0, 0/45); smoke 26→26 (0, 0, 0/60) | memory-set/1: 5→9/11, 0 losses | not admitted: task material ("K12 → Teal") stored as facts; dates in notes misread |
| 2026-10-21 | `memory`, after fixes (mapping-notation sentences are data; no dates) | varied 0/45 touched; smoke 0/60 touched; 0 losses | memory-set/1 (dev): 5→8/11 structural, 9/11 by hand (moved-city is a scorer false negative). **memory-set/2 (held out, written before the fixes ran): 4→7/7**, 0 losses | **admitted** |
| 2026-10-21 | `files` (list_files, read_file), configured Tool Caller (Qwen3 0.6B) | varied 22/28 (1 loss, 16/45 touched); smoke 25/27 (1 loss, 14/60 touched) | tools-set/1: 2→3/7 | not admitted: the 0.6B declined clear file requests and fired on unrelated turns; failed calls' notes shifted answers |
| 2026-10-21 | `files`, worker model routes (0.6B measured unqualified); parameter descriptions; only successful results shown | varied 2 losses, 11/45 touched; smoke 3 losses, 16/60 touched | tools-set/1: 2→6/7 | not admitted: the Tool Caller saw only the bare message and listed files on short rule follow-ups; listings shifted label answers |
| 2026-10-21 | `files`, Tool Caller given the earlier conversation | varied 23→23 (0 losses, 3/45 touched); smoke 26→26 (0/60 touched) | tools-set/1 (dev): 2→5/7 structural, 0 real losses by hand. **tools-set/2 (held out, written before this fix ran): real gains 3 (seat, phone bill, excursion), 0 real losses** | **admitted** |
| 2026-10-21 | `claims` (structural: label beside each item a reply mentions, vs. given and settled labels; appends a correction) | varied 0 losses, 2 false corrections (an example list read as a claim), 4/45 touched; smoke 0/60 | claims-set/1: 4/4 → 4/4, 0 turns touched (with rule notes the model labelled every item right) | **not admitted**: no gain, false fires. In `failed work/components-2026-10-21` |
| 2026-10-21 | `planning` (planner steps as notes for multi-part requests) | varied 2 losses, 39/45 touched; smoke 4 losses, 41/60 touched (plans on 58 of 105 ordinary turns) | planning-set/1: 8/8 → 8/8 (the plain model already solves them) | **not admitted**: no gain, real losses (labels flipped; an impossible premise computed as −2). In `failed work/components-2026-10-21` |
| 2026-10-21 | `amounts` (from the developed version: amounts told and changed, Speck's arithmetic), first run | 0 turns touched anywhere | amounts-set/1: 7/7 → 7/7 | not admitted: never acted (item fields declared only in prose; fixed generally by nested contract fields) |
| 2026-10-21 | `amounts`, nested contract fields | varied 2 losses, 3 gains (savings-jar 55; two rule probes), 28/45 touched; smoke 0 losses, 6/60 touched | amounts-set/1 (dev) 7/7 → 7/7; **amounts-set/2 (held out) 7/8 → 5/8**: fuel 39→26, rain tank 80%→55% | **not admitted**: the intake reader read codes as amounts, read changes twice, and misattributed them. In `failed work/components-2026-10-21` |
| 2026-10-21 | `ledger` (structural: every number the user states, what it counts and whose, from the dependency parse; quoted in order; no model call, no word list) | 0 structural losses; varied savings-jar gained (55, the long-standing shared miss); impossible-tickets flagged in both | **amounts-set/3 (held out, written first) 9/10 → 9/10**: the target, an original value after an update, is still missed. The ledger showed 52% first, and the model still read "originally" as "before the flights". Dev sets: no structural change; one hand probe worse (eating 5 of 3 apples: no longer flagged impossible) | **undecided**: the candidate is kept for the user's keep-or-drop |
| 2026-10-22 | `hypotheses` (S1: reply clauses checked against the user's clauses by qualified paired-entailment; revise on contradiction) | no losses; fires: 2 then 1 per shared run, all false (fragments; a statement the user had since replaced) | hypotheses-set/1 (dev) 3/3 → 3/3; **hypotheses-set/2 (held out) 7/8 → 7/8, 0 domain turns touched** | **not admitted**: no real catch in about 250 turns; S2 (belief revision, to supersede replaced statements) not run as there is nothing to gain. In `failed work/components-2026-10-21` |
| 2026-10-22 | `web` (browser_search + browser_read_page, LAN Playwright on .233) | no losses; with the cache keyed on whole tool definitions: searches on rule-example and plain turns (10/45 varied touched) | web-set/1: RFC title gained; web-set/2: RFC title gained, but searches for general knowledge (sea salt, Berlin Wall, egg, lunch, sleep) | **not admitted**: the router searches where no search is needed even with clearer descriptions, and the search backend returns unrelated pages. Kept as a candidate |
| 2026-10-22 | `pages` (browser_read_page only) | varied 0/45, smoke 0/60 touched, 0 losses | web-set/1 4→6/6 (example.com read, RFC 2549 title); web-set/2 4→5/5 (RFC 1149 title); it built correct addresses for named sites (rust-lang.org, the Eiffel Tower article) | **admitted** (a feature: switch "Read web pages you name", on) |
| 2026-10-22 | `mind` (memory in one persistent worker: activation-based recall and associations, context-engine selection, belief revision by paired-entailment, background consolidation), replacing `memory` | 0/105 shared turns touched, no losses | mind-set/1: 2 real losses (wrong facts recalled), belief revision retired the corrected facts (Mazda, bakery, Melbourne) | not admitted: recall misranked |
| 2026-10-22 | `mind` ablations (one piece off at a time) | — | context off **or** activation off: no real losses; beliefs off or consolidation off: the losses remain | finding: activation and context together recalled stale facts. Facts admitted to working memory in an earlier, unrelated conversation anchored spreading activation |
| 2026-10-22 | `mind`, working memory released when a conversation begins | 0/105 touched, no losses | **mind-set/2 (held out, long-horizon, written before the fix ran): 7/7 = 7/7 by hand** (two scorer misses on "carpentry" and "sailboats" in both arms); dev sets: every changed probe correct in both arms by hand | **admitted in place of `memory`** (same switch). Answers equal the shared-memory component; outdated facts no longer reach the model; about 0.5 more model calls per turn |

### `memory` gate details (2026-10-21)

**Harness change made during this gate.** Speck's own model calls are now replayed by exact request (arms/6.1, speck-calls/1).

The intake model samples at temperature 0.2, so an uncached reader read the same message differently in S0 and S1. One run showed 6 touched varied-set turns that were really reader variance, not memory.

**Gains, read by hand:** occupation, a family member's allergy, a move to a new city, an age difference across two conversations, a pet's name, a workplace, two children's names, a job change. Retention held: "only for this chat" and "don't keep this after today" were never recalled.

**Cost:** on ordinary conversation, 0.3–0.6 extraction calls (1.2B, ~115 ms) and 0.1–0.25 checks by the 4B (~300 ms) per turn. The answer itself takes seconds.

**Follow-ups.** Each change gets a new held-out memory set; memory-set/2 is now development data.

- A name was not extracted ("Hi! I'm Priya"). This is the intake model's miss.
- Facts stated inside a question are skipped. This is the cost of the structural question rule ("As a teacher, how can I…?").
- Restating a fact can drop the relation to the user: "My son Leo is 7" became "Leo is 7 years old", and the model then hedged. Storing the user's own sentence is the candidate fix.
- Retrieval brings irrelevant facts on unrelated questions (cats beside a boiling-point question). No answer was harmed, but it costs tokens. The shared-memory floor of 0.15 is the cause.
- The model sometimes disregards the notes ("I can't recall…" with "I work as a nurse" in front of it).

### `files` gate details (2026-10-21)

**Tool Caller qualification.** The configured Tool Caller (hf.co/iromu/Qwen3-0.6B-tools-GGUF) was probed directly with the same tools, with `think` false, true and unset. It:

- declined "What files are in my workspace?" and "Is there anything in my inbox?";
- listed the inbox for "notes/todo.txt";
- otherwise wrote what it would do without emitting the call.

qwen3:4b (in the approved mix) chose the right tool and arguments on every file request, and declined every message that needed none. The component routes through the worker model. The role configuration is unchanged.

**Speck-side fixes made during this gate:**

- tool parameters carry descriptions, which the Tool Caller sees;
- `proposeToolIntent` takes `allowedTools`;
- only successful tool results become notes;
- the Tool Caller sees the last six turns of the conversation.

**Harness change.** Each arm registers the core tools over a scenario workspace. When the domain set has a workspace, the shared sets run with it too, so a wrongly fired tool has real files to read.

**Gains, read by hand:**

- dev: the todo list, a CSV value, the inbox letter, a follow-up from a file read earlier;
- held out: a flight seat, a phone bill, an inbox note's amount.

**Structural "losses" that were not real:** the pancake and garlic questions. S0 gave generic answers that happened to contain the checked value.

**Cost.** One qwen3:4b routing call per message: median 5.6 s, p90 7.8 s (live, shared sets). This is the largest cost of any admitted component.

**Follow-ups.** Each needs a new held-out tools set; tools-set/2 is now development data.

- Two steps were not enough for list → list folder → read (pancakes, garlic). On garlic the reply then gave a typical harvest month beside the file name, as if it came from the file.
- False positives on statements: "I added 15 dollars this morning." read budget-2026.csv, and a codes message listed the workspace. No answer was harmed.
- Latency: a cheaper routing decision (or skipping it when the workspace is empty) would remove most of the 5.6 s.
- `document_search` (needs an index) and the web tools (need a Playwright service) are not yet measured.

### Not ported or blocked (2026-10-21)

**`threads` (`cognition/segmentation.ts`): not ported.** It is built on word lists:

- English function words, to find a message's subject;
- third-person pronouns, to find a message that leans on earlier ones;
- topic-shift markers.

Under the no-word-lists rule it cannot return as it is. Its role was routing messages between episodes, and that role is gone: on the default path the model sees the whole conversation. Episodes were measured harmful as routing. No structural version is planned unless a failure on the default path calls for one.

**`hypotheses` and `checks`: blocked on checker qualification, not on code.**

- Non-rule hypotheses are updated only through requirement checks by a checker qualified for atomic entailment.
- Reply checks need the same.
- None is qualified: a copy of the live competence store holds no qualification for any processor.
- The record (`docs/experiments/qualification/README.md`) has DeBERTa-v3-large, the configured `nli-checker`, at 58/60 on contradiction. That misses the bar on its lower bound by 0.01.

With every check void, either component would generate model work that can change nothing. They return only after a checker qualifies. The ways forward (the user's decision):

1. extend the corpus with independently written items, so the lower bound is measured more tightly;
2. revisit the provisional thresholds (S31);
3. qualify another small checker.

## Review of the developed version (failed work), 2026-10-21

The user's developed version (`E:\AI\Speck\failed work`) was reviewed for anything usable on the default path.

**Taken:**

- the embedding memo, a pure speed-up (0 of 121 turns changed);
- nested contract fields, general plumbing (no existing schema changed);
- amounts (`quantities.ts`), gated: not admitted (above);
- its generalisation generator, as a broader check (below).

**Not taken:**

- **Single-choice contracts.** The developed version's own measurement shows they change answers.
- **The ~8,000-line language layer.** In its blind benchmark, perception on scored 50/63 at 1,276 calls, against 52/63 at 307 with it off. It is also built on word lists.
- **Fact-reading refinements.** They are pronoun and phrase lists.
- **`assumptions.ts` and `conditional.ts`.** Clean, but nothing on the path feeds them.
- **Recording.** The harness already replays every call.
- **Its later qualification work.** No judgment qualified, so it does not unblock hypotheses or checks.

### Generalisation check (development seed 20261021, one conversation per family)

`gen-run.mjs` runs the developed version's generator, which is the same file as the harness copy. It compares the plain model (A) with the default path (S, admitted components), scored with scoring-v3.

| | all (non-distractor) | distractors |
|---|---|---|
| A | 18/21 | 4/4 |
| S | 18/21 | 4/4 |

**Every S turn was plain, with identical replies.** No family's conversation gave rule examples, spanned sessions or needed a file. The floor holds by construction, and the admitted components neither help nor harm general reasoning.

**Shared misses:**

- state tracking, the original value (both said 77 for 34);
- unknown information: both invented a never-stated habit;
- one likely scorer false negative.

A blind run at full size, 3 per family on a fresh seed, needs the user's approval.


### Harness corrections found during the web gates (2026-10-22)

- **Workspace timestamps.** Workspace files are written fresh for every run, and `list_files` reports their modification time. So listings, and the Tool Caller's next prompt, differed between runs. Workspace files now get a fixed time (arms/6.4). Run-to-run identity on the tools gate: 0 of 232 turns differ.
- **Tool definitions in the call cache key.** The call cache keyed tool-routing calls on tool names alone, so a changed tool description replayed the old decision. It now keys the whole tool definitions (arms/6.6). The earlier files gates were not affected: their description change came with a routing-model change, which changes the key.
- **Web responses replayed.** Responses from the Playwright service are recorded and replayed by exact request (web-calls/1), so a rerun sees the same pages.

### The mind (2026-10-22)

Memory now runs on Speck's own machinery. Facts live in one persistent runtime worker, "What Speck knows about the person it talks with", tagged `speck:mind`.

- **Recall** is by the ACA activation graph: base level, spreading from working memory, and semantic scoring. Each recall reinforces what it found, and facts told together or closely related are associated.
- **Selection:** the context engine's working-memory competition and builder choose what is shown, within a budget.
- **Belief revision:** a new fact that contradicts an older one, by the qualified paired judgment with Speck-formed opposites, retires the older one.
- **Consolidation:** background cognition runs on the mind when a conversation begins.
- **Working memory is per conversation.** It is released when a new conversation begins (`releaseWorkingMemory`, a new runtime operation).

The ablations are kept as candidates (`mind-noctx`, `mind-noact`, `mind-nobel`, `mind-nocons`). On these sets the mind answers as the shared-memory component did. Its distinct effect is that corrected facts are retired rather than shown beside their replacements. Gains that depend on activation or consolidation over much longer use, months of conversations, are not measured by these sets.
