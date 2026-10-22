// Server-sent event streams for the interface: logs and the cognitive event observer.


import { openSse } from "../sse.js";
import { UiContext } from "../context.js";

export function registerEventsRoutes(ctx: UiContext): void {
  const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
  app.get("/events/logs", (req, res) => openSse(req, res, logClients, { ts: Date.now(), line: "[speck] connected" }));
  app.get("/events/observer", (req, res) => openSse(req, res, eventClients, { ts: Date.now(), type: "observer.connected" }));
}
