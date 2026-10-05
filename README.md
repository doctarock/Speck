# SPECK

## Small Persistent Emergent Cognitive Kernel

A lightweight persistent cognitive architecture designed to make small language models substantially more capable by moving as much cognition as practical out of the LLM and into deterministic, persistent, measurable runtime mechanisms.

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
