# Judgment qualification: atomic entailment

Which models may check a hypothesis's requirements (S30, S31). This log records each measurement on the fixed corpus.

Run it with `node dist/cli.js probe qualify --models <a,b> --repetitions 3 [--out file]`. Each result is recorded in the competence store as the model's qualification.

## Why

In the causal test (2026-10-03, an outage told in five messages), Speck never held a hypothesis, and the writer anchored on "Alice's restart caused it". The first fix asked the configured independent model (LFM2.5 1.2B) to judge whole claims against the evidence. It could not:

- It read restatements of the user's facts as claims, 0/3.
- It called "the restart completed and the server stayed healthy" consistent with "the restart caused the outage", 0/3.
- Asked about atomic propositions, it still answered "supported" to nearly everything, 16/33.
- Asked about a proposition and its opposite, it said yes to both in 30/30 cases.

The operator's direction was to keep the checker small, ask it only atomic questions, and accept its verdicts only once it has been measured qualified for that class of judgment. An unqualified checker's verdicts are void. Escalating to a bigger checker until the test passes was ruled out.

## Corpus

The current corpus is `atomic-entailment/4`: 90 contrastive pairs, giving 60 entailment, 60 contradiction and 60 neutral items per repetition. It adds hard negation ("never", "no longer", "failed to", "neither … nor", "only", "except", double negation) and neutral cases where presence or nearness in time tempts a causal reading. One example: "a nurse was on duty when the patient fell" ⇒ "the nurse caused the fall", which is the Alice error in another domain. The first measurement below used the original corpus:

`atomic-entailment/1` has 18 contrastive pairs, giving 36 items per repetition. Each pair is a premise, a proposition and its opposite. The pairs cover time, quantity, agency, state change, explicit negation and unrelated detail. None are about outages.

Across both sides of each pair there are 14 entailment, 14 contradiction and 8 neutral items. Every item is asked exactly as the runtime asks it: one premise, one hypothesis, NLI labels. The outage propositions (9 pairs) are scored beside the corpus and never used to qualify.

## 2026-10-03: installed models, 3 repetitions

Corpus results, from 108 answers per model:

| Model | Entailment | Contradiction | Neutral | Negation consistency | Overall | Qualified |
|---|---|---|---|---|---|---|
| LFM2.5 1.2B (intake) | 26/42 | 0/42 (0%) | 21/24 | 0/32 (0%) | 47/108 (44%) | no |
| qwen3:1.7b | 24/42 | 33/42 (79%) | 24/24 | 18/39 (46%) | 81/108 (75%) | no |
| qwen2.5:1.5b | 35/42 | 33/42 (79%) | 20/24 | 28/44 (64%) | 88/108 (81%) | no |
| gemma3:1b | 14/42 | 18/42 (43%) | 14/24 | 11/43 (26%) | 46/108 (43%) | no |
| Qwen3 0.6B tools | 0/42 | 0/42 (0%) | 24/24 | 0/0 | 24/108 (22%) | no |
| qwen3:4b (writer; reference only) | 38/42 | 42/42 (100%) | 24/24 | 38/42 (90%) | 104/108 (96%) | no |

Outage task set (54 answers per model; never used to qualify):

| Model | Overall | Contradiction |
|---|---|---|
| LFM2.5 1.2B | 26/54 | 2/21 |
| qwen3:1.7b | 20/54 | 2/21 |
| qwen2.5:1.5b | 39/54 | 9/21 |
| gemma3:1b | 24/54 | 6/21 |
| Qwen3 0.6B tools | 10/54 | 0/21 |
| qwen3:4b | 52/54 | 21/21 |

Findings:

- **No model of 2B or under qualifies.** The best, qwen2.5:1.5b, misses one contradiction in five. The LFM2.5 1.2B never answers "contradiction"; it calls them neutral (37/42) or entailment.
- **The Qwen3 0.6B answers "neutral" to everything.** The first version of the negation metric scored that 54/54. Consistency is now counted only where the model committed to a label on at least one side.
- **qwen3:4b is close but does not qualify:** 96% overall, 100% on contradiction, 90% on negation consistency. Its four inconsistencies are entailments it also called contradictions. It is the writer in the configured mix, so it could not check the writer's claims anyway.
- **Consequence for the configured mix:** every requirement check is void. Speck holds the writer's claims and the generated hypotheses unverified, and changes no belief on them. Test #2 cannot pass on Speck's reasoning with this mix until a checker qualifies.

## 2026-10-03: live trajectories with the configured mix (no qualified checker)

- `incremental-rule` (test #1): 13/13, unchanged. Induction tasks are checked by induction, not by S30.
- `causal-outage` (test #2): 5/7.
  - The two reasoning checks fail. Speck held no restart-cause hypothesis at turn 3, and no hypothesis moved: every check was void, so all stayed at 0.50, +0/−0.
  - The reply checks pass because qwen3:4b, on its own in this run, did not blame the restart and named the disk.
  - The first version of this probe scored the run 6/6. Two of its checks passed vacuously: no hypothesis was held, and ranking was decided by insertion order at equal confidence. They now require Speck's state to have held and moved the hypotheses.
  - The writer's model also read some restatements as claims ("Alice issued a restart command at 2:13 AM").

**Status of test #2: the architecture is capable, the configuration blocks it.** No independently qualified atomic-entailment evaluator is available. This differs in kind from the original failure:

- **Before:** a wrong judgment produced a wrong belief. The writer confidently kept "the restart caused it".
- **Now:** an unqualified judgment is void and no belief moves.

The probe stays red, and it will not be changed to accommodate any of this.

## 2026-10-03: corpus v3, statistical qualification, purpose-trained NLI models

**Qualification is now statistical** (S31). A model qualifies when, over at least 60 distinct items per class, the lower end of the 95% Wilson interval reaches:

- 0.85 overall;
- 0.90 on contradiction;
- 0.90 on negation consistency.

Repetitions are not counted as independent samples; the rate is averaged over them. With 60 items, one miss still qualifies (59/60 → 0.91) and two do not (0.89). These bars are provisional.

Results on corpus v3. The LLMs ran 3 repetitions; the cross-encoders are deterministic and ran once. LB is the lower bound the verdict uses.

| Model | Size | Entailment | Contradiction | Neutral | Negation consistency | Overall | Qualified | Outage set overall / contradiction | ms per call |
|---|---|---|---|---|---|---|---|---|---|
| LFM2.5 1.2B (intake) | LLM | 71% | 6% (LB 0.02) | 81% | 6% (LB 0.02) | 53% (LB 0.46) | no | 41% / 5% | 63 |
| qwen3:1.7b | LLM | 64% | 59% (LB 0.47) | 97% | 55% (LB 0.41) | 74% (LB 0.67) | no | 39% / 14% | 66 |
| qwen2.5:1.5b | LLM | 80% | 80% (LB 0.68) | 78% | 62% (LB 0.50) | 79% (LB 0.73) | no | 72% / 43% | 77 |
| gemma3:1b | LLM | 15% | 36% (LB 0.25) | 68% | 13% (LB 0.07) | 39% (LB 0.33) | no | 44% / 29% | 108 |
| Qwen3 0.6B tools | LLM | 0% | 0% | 100% | – | 33% (LB 0.27) | no | 20% / 5% | 99 |
| qwen3:4b (writer; reference) | LLM | 96% | 98% (LB 0.91) | 86% | 87% (LB 0.77) | 93% (LB 0.88) | no | 100% / 100% | 163 |
| cross-encoder/nli-deberta-v3-xsmall | 71M | 67% | 85% (LB 0.74) | 80% | 57% (LB 0.45) | 77% (LB 0.71) | no | 78% / 86% | 32 |
| cross-encoder/nli-deberta-v3-small | 142M | 65% | 85% (LB 0.74) | 72% | 56% (LB 0.44) | 74% (LB 0.67) | no | 78% / 86% | 8 |
| cross-encoder/nli-deberta-v3-base | 184M | 72% | 90% (LB 0.80) | 83% | 68% (LB 0.56) | 82% (LB 0.75) | no | 67% / 100% | 17 |
| MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli | 184M | 77% | 90% (LB 0.80) | 85% | 71% (LB 0.59) | 84% (LB 0.78) | no | 89% / 100% | 21 |
| MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli | 435M | 88% | 97% (LB 0.89) | 97% | 89% (LB 0.78) | 94% (LB 0.89) | no | 100% / 100% | 26 |
| FacebookAI/roberta-large-mnli | 355M | 82% | 93% (LB 0.84) | 80% | 68% (LB 0.56) | 85% (LB 0.79) | no | 78% / 100% | 10 |

Findings:

- **Nothing qualifies yet.**
- **A purpose-trained 435M cross-encoder is level with the 4B writer, at a tenth of its size and a sixth of its latency.** It reached 97% on contradiction, 94% overall and 100%/100% on the outage set, and it is independent of the writer. Every cross-encoder detects contradiction better than any LLM of 2B or under; their weakness is negation consistency.
- **DeBERTa-large misses the contradiction bar by 0.01 (58/60), on clear items:**
  - transitivity: "Zoe is taller than Max, Max taller than Ben" ⇒ it called "Zoe is not taller than Ben" entailment;
  - a vegetarian since 2019: it called "Chen ate meat in 2022" neutral.
- **qwen3:4b's misses are also clear errors.** It called "only two of five lights work" ⇒ "most are broken" a contradiction, 3/3. It often calls the negation of an unstated detail a contradiction ("a burglar did not break the window").
- **Three items have arguable gold labels** and are not changed yet; changing them after seeing which models failed them would tune the corpus to the candidates:
  - "sold out within an hour" ⇒ "not on sale the next day" (resale);
  - "fully booked for the whole of August" ⇒ "no empty rooms mid-August" (no-shows);
  - "never learned to drive" ⇒ "did not drive herself yesterday".
  None of them is among DeBERTa-large's contradiction misses.

## 2026-10-03: test #2 rerun, unchanged, after the fixes (still no qualified checker)

`causal-outage`: **3/7**. This time qwen3:4b anchored as in the operator's original run: "The server went offline at 2:14 AM due to Alice issuing a restart command at 2:13 AM", repeated through turn 6.

- **Speck's state captured the claim.** It has been held as a hypothesis since turn 2. Every check was void, so it never moved and the anchoring went unchallenged, as it must without a trustworthy judgment.
- **The earlier 5/7 was the writer's luck.** This run confirms the probe tells the two apart.
- **No turn was re-planned.** The follow-up routing fix held: every turn completed with a reply.
- **Probe weakness, not changed:** the check "says the restart's meaning changed" passed on a final reply that still blames the restart, because its sentence contains "restart" and "completed".

## 2026-10-03: corpus v4

v4 rewrites the three items whose gold labels were arguable. The rewrite was made after seeing the v3 results, and the fix was chosen by the wording alone:

- "The box office sold every ticket … and had none left to sell after that" ⇒ "was still selling tickets the next day" is a contradiction. In v3 the premise was "sold out", and resale made the label arguable.
- "Every room in the hotel was occupied every night in August" ⇒ "had empty rooms in mid-August" is a contradiction. In v3 it was "fully booked", and no-shows made the label arguable.
- "Fatima cannot drive and has never driven a car" ⇒ "drove herself to work yesterday" is a contradiction. In v3 she had only "never learned to drive".

v3 measurements do not count for v4; models are remeasured.

## 2026-10-03: cross-encoders as Speck processors, corpus v4

The cross-encoders now run as Speck processors (provider `nli`, served by `sidecars/nli`). They were measured through that provider with `probe qualify --models "nli:<model>"`, one repetition each (they are deterministic).

| Model | Contradiction | Negation consistency | Entailment | Neutral | Overall | Qualified | Outage set overall / contradiction | ms per call |
|---|---|---|---|---|---|---|---|---|
| cross-encoder/nli-deberta-v3-xsmall | 51/60 | 40/69 | 41/60 | 48/60 | 140/180 | no | 14/18 / 6/7 | 29 |
| cross-encoder/nli-deberta-v3-small | 51/60 | 41/72 | 40/60 | 43/60 | 134/180 | no | 14/18 / 6/7 | 21 |
| cross-encoder/nli-deberta-v3-base | 55/60 | 45/66 | 43/60 | 50/60 | 148/180 | no | 12/18 / 7/7 | 32 |
| MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli | 55/60 | 48/67 | 47/60 | 51/60 | 153/180 | no | 16/18 / 7/7 | 24 |
| MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli | 58/60 | 54/61 | 53/60 | 58/60 | 169/180 | no | 18/18 / 7/7 | 23 |
| FacebookAI/roberta-large-mnli | 56/60 | 49/71 | 50/60 | 48/60 | 154/180 | no | 14/18 / 7/7 | 25 |

- **The provider reproduces the scratch benchmark.** DeBERTa-large scored 58/60 on contradiction both ways.
- **DeBERTa-large is now configured** as `nli-checker` in `data/genesis-runtime/model-processors.json`. It is unqualified, so its checks stay void.
- **What keeps it out is negation consistency (54/61) and two clear contradiction misses** (transitivity, and the vegetarian who "ate meat in 2022"). Its answer on test #2's key requirement is correct: "The restart left the server unhealthy" against "The server remained healthy afterward" is a contradiction at 0.9997.

LLMs on corpus v4 (3 repetitions, so 180 answers per class):

| Model | Contradiction | Negation consistency | Entailment | Neutral | Overall | Qualified | Outage set overall / contradiction | ms per call |
|---|---|---|---|---|---|---|---|---|
| LFM2.5 1.2B (intake) | 9/180 | 9/173 | 129/180 | 145/180 | 283/540 | no | 24/54 / 2/21 | 101 |
| qwen3:1.7b | 110/180 | 83/153 | 116/180 | 174/180 | 400/540 | no | 21/54 / 3/21 | 75 |
| qwen2.5:1.5b | 141/180 | 124/209 | 141/180 | 135/180 | 417/540 | no | 40/54 / 10/21 | 87 |
| gemma3:1b | 61/180 | 21/175 | 24/180 | 121/180 | 206/540 | no | 24/54 / 6/21 | 113 |
| Qwen3 0.6B tools | 0/180 | – | 0/180 | 180/180 | 180/540 | no | 13/54 / 2/21 | 141 |
| qwen3:4b (writer; reference) | 177/180 | 176/201 | 176/180 | 153/180 | 506/540 | no | 52/54 / 21/21 | 209 |

- qwen3:4b is now nearly perfect on contradiction (98%) and entailment. It fails on negation consistency (88%) and neutral (85%).
- No model, LLM or cross-encoder, qualifies on v4.

## Open

- Decide whether a non-LLM checker (a cross-encoder) becomes a Speck processor. It needs a provider (a Python sidecar, or ONNX through transformers.js), and none qualifies under the current bars: the best misses on clear contradiction items.
- Set the thresholds from the measured spread.
- Fixed 2026-10-03: the competence store merged by replaying each process's changes onto the file under a lock. Before that, a running server overwrote qualifications recorded by `probe qualify`. A server started before the fix still runs the old code until it is restarted.

## 2026-10-22: the paired judgment, and corpus v5 additions

**Correction.** DeBERTa-large was said, on 2026-10-21, to "miss the bar by 0.01". It misses two bars:

- contradiction: 58/60, lower bound 0.89;
- negation consistency: 54/61, lower bound about 0.78.

An 89% consistency rate cannot reach a 0.90 lower bound at any corpus size.

**The paired judgment (a change to what Speck asks, not to the bars).** Speck asks the checker about the proposition and about its opposite, and accepts the verdict only when the two answers are opposed as labels are (entailment against contradiction, neutral against neutral). Otherwise the judgment is void: Speck abstains, as it does with no qualified checker.

Negation consistency then holds by construction. What is qualified is the paired judgment's accuracy on the verdicts it commits to, at the same bars, over at least 60 committed items per class. Its abstention rate is reported beside it.

**Corpus v5 additions** (`src/metacognition/entailment-corpus-v5.ts`, sha256 in `corpus-v5-additions.sha256`):

- 90 new contrastive pairs, 30 per label;
- written before any model saw them;
- evenly across the corpus's categories, not chosen by any model's errors.

The probe measures them with `probe qualify --corpus v5-additions --no-record`. A qualification is recorded only on the official corpus.

DeBERTa-v3-large (`nli-checker`), 1 repetition (it is deterministic). The raw answers are in `2026-10-22/`.

| Paired judgment | v5 additions | v4 + v5 (180 pairs) | Bar |
|---|---|---|---|
| Contradiction | 54/54 | 107/109 (LB 0.936) | 0.90 |
| Entailment | 54/54 | 107/109 (LB 0.936) | — |
| Neutral | 60/60 | 116/116 (LB 0.968) | — |
| Overall | 168/168 | 330/334 (LB 0.970) | 0.85 |
| Abstained | 6/90 | 13/180 (7%) | reported |

- On the 90 unseen pairs it committed no wrong verdict.
- The two wrong committed pairs are both v4 items: transitivity ("taller than") and a negated paraphrase ("did not eat meat in 2022").
- Every self-contradicting answer was abstained on.
- Single-ask accuracy on v4 + v5, for comparison: contradiction 116/120, entailment 109/120, neutral 118/120.

**Status:**

- The paired judgment meets the bars on v4 + v5.
- It is not yet recorded as a qualification; that needs the following, scored as above, and then a recorded run on corpus v5 (v4 + additions):
  - the paired capability in `qualification.ts`;
  - its runtime ask, which checks a requirement and its opposite.
- The opposite a requirement is checked against must come from somewhere at runtime. The corpus's opposites are hand-written. Hypotheses would have to state each requirement with its opposite (a contract field), or Speck would have to form it.

## 2026-10-22: Speck-formed opposites; paired-entailment qualifies

**Where the runtime opposite comes from.** Speck forms it from the dependency parse (`src/speck/negation.ts`), with no model:

- a clause is negated through its verb, keeping its tense and any prefix;
- a negated clause loses its negation;
- a clause with a quantified subject takes "It is not true that P".

Three forms were compared with DeBERTa-large on the paired judgment. The form was chosen on v4 and confirmed on the v5 additions (`2026-10-22/neg-measure.json`):

- verb negation only;
- the wrapper only;
- verb, with the wrapper for quantified subjects.

**That comparison ran its parses in parallel. Some failed and silently fell back to the wrapper**, so its per-form numbers are approximate. The chosen form, verb-or-wrapper, was then measured cleanly through the probe:

```
probe qualify --models nli-checker --capability paired-entailment --repetitions 1 --no-record
```

That run parses one item at a time, and the probe refuses to run without the parse sidecar.

| paired-entailment (corpus `atomic-entailment/5+opposites:verb-or-wrapper/1`) | Result | Lower bound | Bar |
|---|---|---|---|
| Contradiction | 108/110 | 0.936 | 0.90 |
| Entailment | 108/110 | — | — |
| Neutral | 116/116 | — | — |
| Overall | 332/336 | 0.970 | 0.85 |
| Abstained pairs | 12/180 | — | — |
| **Qualified** | **yes** | | |

- The two wrong committed pairs are the same two as with hand-written opposites: "Zoe is taller than Ben" (transitivity) and "Chen did not eat meat in 2022". These are the checker's limits, not the opposites'.
- Outage task set, which never counts towards qualification: 16/16 committed correct, 1 of 9 pairs abstained.
- Latency: 24 ms per question.
- **Not yet recorded** in the live competence store; that waits for the user. Recording binds the corpus version above.
