# SPECK

## Small Persistent Emergent Cognitive Kernel

**Speck is a cognitive runtime designed to make small language models substantially more capable by moving cognition out of the prompt and into persistent, deterministic software.**

Instead of repeatedly asking an LLM to simulate memory, attention, planning, evidence tracking, confidence, learning and metacognition, Speck implements those mechanisms in the runtime itself.

> **The model is disposable. The cognitive state is not.**

A worker can unload its model, change models, restart, or migrate to another compute device without losing the cognitive state of its task.

Speck is built on the Genesis runtime and incorporates mechanisms derived from experiments in [Artificial Cognitive Architecture Omega Gen2](https://github.com/doctarock/Artificial-Cognitive-Architecture-Omega-Gen2), but it is **not a fork or rewrite of Omega**.

---

# Why Speck Exists

Most LLM agents place an enormous amount of responsibility on the model.

The model is expected to:

- remember what happened
- determine what matters
- maintain task state
- recognise contradictions
- track evidence
- estimate confidence
- plan
- reconsider failed approaches
- decide what to retain
- use tools correctly
- learn from outcomes
- produce the final answer

Much of this work does not inherently require a language model.

Speck starts from a different principle:

> **Anything that can be remembered, measured, ranked, checked, persisted, scheduled, validated, learned procedurally or calculated deterministically should not consume LLM intelligence twice.**

The LLM is therefore treated as a specialised semantic processor inside a larger cognitive system rather than as the entire system.

This is particularly important for small local models.

A large model can often compensate for weak agent architecture with raw intelligence.

A 1B–7B model cannot.

Speck attempts to provide the missing machinery.

---

# The Architecture

At a high level, Speck separates **cognitive state** from **model inference**.

```text
                    USER / ENVIRONMENT
                           │
                           ▼
                        INTAKE
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
           MEMORY                    EVIDENCE
         ACTIVATION                  / CLAIMS
              │                         │
              └────────────┬────────────┘
                           ▼
                     COMPETITION
                           │
                           ▼
                    WORKING CONTEXT
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
          PLANNER        WORKER     METACOGNITION
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                       VALIDATION
                           │
                    ┌──────┴──────┐
                    ▼             ▼
                  REPLY          TOOLS
                    │             │
                    └──────┬──────┘
                           ▼
                  OUTCOME / EVIDENCE
                           │
                           ▼
               MEMORY + BELIEF UPDATE
                           │
                           └──────► next cycle
```

The model participates in cognition.

It does not own cognition.

---

# Cognitive Subsystems

Speck contains runtime mechanisms for several processes normally delegated to prompts or large models.

## Persistent Memory

Memory is stored independently of the currently loaded model.

The runtime supports mechanisms including:

- persistent task state
- memory admission
- embedding-based retrieval
- activation
- associative edges
- memory graphs
- grounding
- domain anchors
- contextual recall

Relevant memories can compete for inclusion in working context rather than simply being dumped into the model's context window.

---

## Attention and Competition

Not everything remembered should occupy the model's attention.

Speck can rank and compete candidate information before constructing working context.

This allows limited model context to be spent on information that is more likely to matter to the current task.

---

## Evidence and Beliefs

Speck distinguishes between information being present and information being established.

The runtime can maintain:

- claims
- supporting evidence
- conflicting evidence
- confidence
- provisional hypotheses
- belief revision

New evidence can therefore change persistent state without requiring the model to reconstruct the entire reasoning history.

---

## Grounding

Candidate information can be checked against user statements and existing evidence before it becomes persistent knowledge.

Grounding can combine semantic similarity with deterministic signals rather than relying entirely on an LLM to decide what the user previously said.

Uncertain information can remain task-local until sufficiently supported.

---

## Planning and Coordination

Planning is separated from execution.

Different models can therefore be assigned to different cognitive roles.

For example:

```text
Intake       → small fast model
Planner      → stronger reasoning model
Worker       → general-purpose model
Validator    → independent model or deterministic check
Embeddings   → dedicated embedding model
```

There is no requirement for every role to use the same model.

---

## Metacognition

Speck maintains runtime information about its own performance rather than merely prompting a model to "reflect."

This includes mechanisms for:

- assessment
- calibration
- competence tracking
- prediction
- outcome comparison

The objective is not introspection for its own sake.

It is to improve future decisions.

---

## Proceduralisation

Repeated successful behaviour should not require rediscovery forever.

Speck can represent procedures independently of conversational memory, allowing successful patterns to become reusable runtime knowledge.

The long-term goal is simple:

> **Do not repeatedly spend inference on problems the system has already learned how to solve.**

---

# Small Models Are a Design Constraint

Speck is deliberately developed against small local models.

This exposes weaknesses that large frontier models can hide.

Small models may:

- misunderstand complex prompts
- lose state
- mishandle negation
- hallucinate structure
- perform poor arithmetic
- choose inappropriate tools
- accept unsupported conclusions
- prematurely ask the user for information
- drift from supplied evidence

Speck does not assume these problems can all be solved with better prompting.

Where practical, responsibility is moved out of the model entirely.

```text
LLM responsibility
        │
        ▼
Can software perform this reliably?
        │
   ┌────┴────┐
  YES        NO
   │          │
Runtime      Model
mechanism   judgement
```

Model outputs can then be treated as proposals rather than unquestioned state transitions.

---

# Model Independence

One of Speck's fundamental design constraints is:

> **No model should be the identity of the agent.**

Models are replaceable cognitive resources.

A task may begin using one worker model and continue using another.

A model can be:

- unloaded
- upgraded
- downgraded
- replaced
- moved to another device
- assigned a different cognitive role

without discarding the persistent state surrounding the task.

This makes heterogeneous local inference practical.

---

# Tools and Action

Speck includes a tool layer rather than allowing arbitrary model output to directly become action.

The runtime contains support for:

- tool registration
- tool intents
- workspace operations
- transactional workspace changes
- browser automation
- Genesis tools
- validation before execution

Tool selection and tool execution can therefore be independently inspected and constrained.

---

# Genesis Runtime

Speck is built on the **Genesis runtime**.

Genesis provides the surrounding agent infrastructure, including plugin hosting, profiles, UI integration and runtime services.

Speck provides the cognitive layer.

Conceptually:

```text
┌────────────────────────────────────────────┐
│                  SPECK                     │
│                                            │
│ Memory • Attention • Evidence • Beliefs   │
│ Planning • Metacognition • Procedures     │
│ Validation • Cognitive State              │
└─────────────────────┬──────────────────────┘
                      │
┌─────────────────────▼──────────────────────┐
│                 GENESIS                    │
│                                            │
│ Plugins • Tools • Profiles • Runtime      │
│ Services • Interfaces • Infrastructure    │
└────────────────────────────────────────────┘
```

---

# Measurable Cognition

Speck is intended to be experimentally testable.

The repository includes benchmarking infrastructure for:

- role qualification
- trajectories
- tool behaviour
- validation
- comparison
- ablation testing
- cognitive metrics

This is important because adding more cognitive machinery does not automatically make an agent better.

A mechanism should be removable and testable.

If removing a component produces no measurable difference, its value should be questioned.

---

# Speck vs Conventional Agent Loops

A conventional agent often resembles:

```text
Prompt
  ↓
LLM
  ↓
Tool
  ↓
LLM
  ↓
Tool
  ↓
LLM
  ↓
Answer
```

Speck is closer to:

```text
Environment
     ↓
Persistent Cognitive State
     ↓
Evidence + Memory + Attention
     ↓
Working Context
     ↓
Specialised Model Judgement
     ↓
Independent Validation
     ↓
Action
     ↓
Measured Outcome
     ↓
Belief / Memory / Procedure Update
     ↓
Next Cognitive Cycle
```

The distinction is intentional.

Speck is not primarily attempting to build a better prompt loop.

It is attempting to build the machinery surrounding the model.

---

# Local First

Speck is designed to work with locally hosted models and services.

A default installation:

- binds to loopback
- stores runtime data locally
- does not require a cloud model
- does not enable model, embedding or browser services unless configured
- keeps credentials and personal runtime data outside the repository

Cloud models can still be used when desired.

They are resources available to the cognitive system rather than a requirement for the architecture.

---

# Getting Started

### Requirements

- Node.js 18 or newer

Clone the repository:

```bash
git clone https://github.com/doctarock/Speck.git
cd Speck
```

Install dependencies:

```bash
npm install
```

Start Speck:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:4310
```

Fresh runtime data will be created under:

```text
data/
```

Model, embedding and browser services remain disabled until explicitly configured.

---

# Development

Build:

```bash
npm run build
```

Type-check:

```bash
npm run check
```

Run the test suite:

```bash
npm test
```

Run the benchmark suite:

```bash
npm run benchmark:suite
```

---

# Current Status

Speck is an active experimental project.

The architecture is functional, but it should not yet be interpreted as a claim that every cognitive mechanism improves every task or every model.

The project deliberately includes benchmarks, probes and ablation infrastructure so those claims can be tested rather than assumed.

Some mechanisms will work.

Some will need refinement.

Some may eventually be removed.

That is part of the experiment.

---

# Relationship to Omega

Speck incorporates ideas explored in **Artificial Cognitive Architecture Omega Gen2**, particularly around persistent cognition, memory, attention, competition, evidence and cognitive state.

The objectives are different.

**Omega asks:**

> What happens if we attempt to construct increasingly mind-like persistent artificial cognition?

**Speck asks:**

> How much model intelligence can be replaced or amplified by persistent computational cognitive machinery?

Omega explores artificial cognition.

Speck attempts to make that cognition useful as infrastructure.

---

# Design Principles

1. **The model is disposable. The cognitive state is not.**

2. **Do not use inference for deterministic work.**

3. **Models make semantic judgements; software enforces policy.**

4. **Model output is evidence, not automatically truth.**

5. **Memory should compete for attention rather than flood context.**

6. **Successful reasoning should become reusable knowledge where possible.**

7. **Failures should modify future behaviour.**

8. **Different cognitive jobs may require different models.**

9. **Small models are a constraint, not an afterthought.**

10. **Cognitive mechanisms should be measurable and removable.**

---

# The Experiment

Speck ultimately tests a fairly simple hypothesis:

> **How much of what we currently call LLM intelligence actually needs to live inside the LLM?**

Modern agents repeatedly ask enormous neural networks to remember, organise, reconsider, compare, track, schedule and validate information that conventional software can often handle more reliably.

Speck moves those responsibilities outward.

If successful, increasingly capable agents should become possible using smaller models, less inference, persistent knowledge and measurable cognitive machinery.

The goal is not to make a small model pretend to be a large model.

The goal is to give the small model a better brain around it.

---

**Small model. Persistent mind.**

### Implementation Specification — Genesis Runtime / ACA-Derived Architecture

Speck is inspired by mechanisms developed in Artificial Cognitive Architecture Omega Gen2, but it is **not a rewrite or fork of Omega**.

Omega is an experiment in artificial cognition and autonomous mind-like behaviour.

Speck has a different objective:

> Use conventional software to provide memory, attention, state, learning, planning support, metacognition, evidence tracking and proceduralisation so that a small LLM only performs operations that genuinely require semantic intelligence.

The central design principle is:

> Anything that can be remembered, measured, ranked, checked, persisted, scheduled, validated, learned procedurally or calculated deterministically should not consume LLM intelligence twice.

A second critical principle:

> The model is disposable. The cognitive state is not.

A worker must survive unloading its model, changing models, restarting the process, or migrating to another compute device without losing its task state.

This distribution includes Speck's compiled server, browser interface, and the Genesis runtime modules it uses. It does not include optional plugins, credentials, or user data.

## Getting started

Requirements: Node.js 18 or newer.

```powershell
npm install
npm start
```

Open `http://127.0.0.1:4310`. The server binds to loopback by default and creates fresh runtime data under `data/`. Model, embedding, and browser services are disabled unless explicitly configured. Keep credentials and personal data in local settings, never in this repository.
