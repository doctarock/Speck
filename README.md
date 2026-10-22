# SPECK

## Small Persistent Emergent Cognitive Kernel

Speck is a cognitive runtime for small local language models, built on the Genesis runtime. Its principle:

> **Anything that can be remembered, measured, ranked, checked, persisted, scheduled, validated or calculated deterministically should not consume a model's intelligence.**

The model is treated as a semantic processor inside a larger system, not as the whole system.

Speck incorporates mechanisms derived from [Artificial Cognitive Architecture Omega Gen2](https://github.com/doctarock/Artificial-Cognitive-Architecture-Omega-Gen2), but it is not a fork or rewrite of it.

[Listed in Awesome AI Agents 2026](https://github.com/ARUNAGIRINATHAN-K/awesome-ai-agents-2026)

## How it works now

Every message is answered by the model's ordinary chat, exactly as the model would answer on its own. That plain model is the **floor**.

Speck adds **components** on top, each only where it has something to add. A component can:

- **observe** a message and keep its own state;
- **contribute** notes the model sees with the conversation;
- **review** the reply.

A message no component acts on is sent to the model unchanged.

### Admission gate

A component goes on the default path only after a **no-harm gate**:

- It runs on shared test conversations with and without the candidate. No answer the path got right may be lost, and every turn it touched is read by hand.
- It runs on its own domain set, written before its code. A fix shaped by that set is confirmed on a held-out set written before the fix ran.

`docs/REINTEGRATION.md` records every gate, including the failures.

### Component types and switches

- **Components that improve answers** have no switch and are always on.
- **Components that add a feature or cost time** have a switch under **System → Cognition → Speck components**.

| Component | What it does | Switch | Cost per message |
|---|---|---|---|
| Rule learning | Reads labelled examples written as `item → label`, derives the rules they allow, and gives the model Speck's derivation. Replaces a reply that mislabels the asked item. | none (always on) | a small reader call, only on messages with a mapping symbol |
| Memory across conversations (the mind) | Keeps facts you state about yourself, respecting "don't keep this" and "only for this chat", in one persistent mind. Recall runs on Speck's activation machinery (ACT-R base level, spreading activation, reinforcement and associations), the context engine chooses what is shown, belief revision retires a fact you have corrected, and background consolidation runs between conversations. | on | about 0.2–0.6 s |
| Read workspace files | Lists and reads files in Speck's confined workspace and inbox when a message needs them. | on | about 5–8 s to decide |
| Read web pages you name | Opens a web address you give, or one it can build from a named site, through a Playwright service. | on | about 5–8 s to decide, plus the page load |

### What the measurements say

All figures below are measured with qwen3:4b as the answering model.

- **General reasoning:** Speck ties the plain model. On an 18-conversation held-out set and on a generated benchmark across 11 reasoning families, every reply matched. The plain path is the floor, and no admitted component costs a correct answer.
- **Gains:** Speck wins where the plain model cannot help itself:
  - rule tasks, including the plain model's slips on generated rule sets;
  - facts from earlier conversations;
  - your workspace files;
  - web pages, where it read invented RFC titles correctly instead.
- **Tried and not admitted:**
  - a structural claim checker and a planner;
  - model-read amount tracking;
  - a reply-contradiction check (accurate, but with nothing to catch);
  - web search, whose router searched for general knowledge.

  Each is recorded with its results. The earlier worker pipeline was measured to cost answers and is not on the path.

### Contradiction checking without a language model

The checker (`paired-entailment`) asks a small NLI cross-encoder about a proposition and about its opposite, and commits only when the two answers agree. The opposite is formed by Speck from a dependency parse, with no LLM involved. The mind uses it for belief revision.

With DeBERTa-v3-large it qualifies on 180 contrastive pairs: contradiction 108/110 (95% lower bound 0.936), overall 332/336. See `docs/experiments/qualification/README.md`.

## Requirements

- **Node.js 22**, and **Ollama** with the models in your configuration. The measured mix:
  - `qwen3:4b`, the answering and routing model;
  - `LiquidAI/lfm2.5-1.2b-instruct:q8_0`, the example and fact reader.
- **An embedding service** for memory (nomic-embed-text-v1.5 served by llama.cpp or Ollama). Without it, memory falls back to a degraded hash encoder.
- **Optional:**
  - a **Playwright service** for web pages; set its address under System → Web;
  - the **NLI sidecar** (`sidecars/nli`) and the **parse sidecar** (`sidecars/parse`, spaCy `en_core_web_sm`). Belief revision in the mind uses both, and the qualification probe needs them. Without them the mind still recalls; corrected facts just stay beside their replacements.

## Running

```powershell
npm install
npm run build
npm test
node dist/server.js            # the interface on http://127.0.0.1:4310
node dist/cli.js chat "Hello"  # one message on the default path
```

Models and roles are configured in `data/genesis-runtime/model-processors.json`. Settings and the conversation are kept under `data/`; override the database with `SPECK_DB_PATH`.

Plugins are discovered only below this repository's `plugins/` directory. They load without hashing by default. To lock them, set `"mode": "allowlist"` with module hashes in `plugins/.runtime/plugin-trust.json`.

Scheduled messages are answered on the default path in their own sessions.

## Status

The default path is stable and gated. Speck's memory machinery runs on it inside the mind:

- memory activation;
- context assembly;
- belief revision;
- background consolidation.

Further components return under the gate described in `docs/REINTEGRATION.md`.

## License

MIT
