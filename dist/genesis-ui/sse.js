// Server-sent events.
export function openSse(req, res, clients, initial) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    clients.add(res);
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
    req.on("close", () => clients.delete(res));
}
export function broadcastSse(clients, payload) {
    const encoded = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients)
        client.write(encoded);
}
//# sourceMappingURL=sse.js.map