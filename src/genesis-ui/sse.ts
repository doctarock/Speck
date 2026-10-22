// Server-sent events.

import { type Response } from "express";


export function openSse(req: any, res: Response, clients: Set<Response>, initial: Record<string, unknown>) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  clients.add(res);
  res.write(`data: ${JSON.stringify(initial)}\n\n`);
  req.on("close", () => clients.delete(res));
}

export function broadcastSse(clients: Set<Response>, payload: Record<string, unknown>) {
  const encoded = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(encoded);
}
