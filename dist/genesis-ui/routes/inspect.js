// Workspace inspection, uploads to the inbox, and the outbox.
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { errorMessage } from "../presentation.js";
import { collectWorkspaceEntries, resolveExistingWorkspaceFile, resolveNewWorkspaceFile, fileErrorStatus } from "../files.js";
export function registerInspectRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.get("/api/regressions/list", (_req, res) => res.json({ ok: true, suites: [] }));
    app.post("/api/regressions/run", (_req, res) => res.json({ ok: true, report: { suites: [], summary: "No Genesis regression suites are installed." } }));
    const inspectRoots = { workspace: workspaceRoot, inbox: inboxRoot, outbox: outboxRoot };
    app.get("/api/inspect/manifest", (_req, res) => res.json({
        ok: true,
        scopes: [
            { id: "workspace", label: "Workspace", description: "Files Speck can work with." },
            { id: "inbox", label: "Inbox", description: "Files supplied to Speck." },
            { id: "outbox", label: "Outbox", description: "Files produced by Speck." }
        ]
    }));
    app.get("/api/inspect/tree", async (req, res) => {
        try {
            const scope = String(req.query.scope ?? "workspace");
            const root = inspectRoots[scope];
            if (!root)
                throw new TypeError(`Unknown inspect scope: ${scope}`);
            res.json({ ok: true, scope, entries: await collectWorkspaceEntries(root) });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/inspect/file", async (req, res) => {
        try {
            const scope = String(req.query.scope ?? "workspace");
            const root = inspectRoots[scope];
            if (!root)
                throw new TypeError(`Unknown inspect scope: ${scope}`);
            const file = String(req.query.file ?? "").trim();
            if (!file)
                throw new TypeError("file is required");
            const target = await resolveExistingWorkspaceFile(root, file);
            const stat = await fs.stat(target);
            if (stat.size > 2_000_000)
                throw new RangeError("Inline text preview is limited to 2 MB");
            res.json({ ok: true, scope, file: file.replaceAll("\\", "/"), content: await fs.readFile(target, "utf8") });
        }
        catch (error) {
            res.status(fileErrorStatus(error)).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/inspect/open", async (req, res) => {
        try {
            const scope = String(req.query.scope ?? "workspace");
            const root = inspectRoots[scope];
            if (!root)
                throw new TypeError(`Unknown inspect scope: ${scope}`);
            const file = String(req.query.file ?? "").trim();
            if (!file)
                throw new TypeError("file is required");
            res.sendFile(await resolveExistingWorkspaceFile(root, file));
        }
        catch (error) {
            res.status(fileErrorStatus(error)).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/inspect/download", async (req, res) => {
        try {
            const scope = String(req.query.scope ?? "workspace");
            const root = inspectRoots[scope];
            if (!root)
                throw new TypeError(`Unknown inspect scope: ${scope}`);
            const file = String(req.query.file ?? "").trim();
            if (!file)
                throw new TypeError("file is required");
            const target = await resolveExistingWorkspaceFile(root, file);
            res.download(target, path.basename(target));
        }
        catch (error) {
            res.status(fileErrorStatus(error)).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/inspect/upload", express.raw({ type: "application/octet-stream", limit: "20mb" }), async (req, res) => {
        try {
            const file = String(req.query.file ?? "").trim();
            if (!file)
                throw new TypeError("file is required");
            if (!Buffer.isBuffer(req.body))
                throw new TypeError("upload body must be application/octet-stream");
            const target = await resolveNewWorkspaceFile(inboxRoot, file);
            await fs.writeFile(target, req.body, { flag: "wx" });
            const stat = await fs.stat(target);
            res.status(201).json({
                ok: true,
                file: `inbox/${path.basename(target)}`,
                name: path.basename(target),
                size: stat.size,
                message: `${path.basename(target)} added to the workspace inbox.`
            });
        }
        catch (error) {
            const status = typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST" ? 409 : fileErrorStatus(error);
            res.status(status).json({ ok: false, error: status === 409 ? "A file with that name already exists in the workspace inbox" : errorMessage(error) });
        }
    });
    app.get("/api/output/list", async (_req, res) => {
        try {
            res.json({ ok: true, files: await collectWorkspaceEntries(outboxRoot) });
        }
        catch (error) {
            res.status(500).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/output/file", async (req, res) => {
        try {
            const file = String(req.query.file ?? "").trim();
            if (!file)
                throw new TypeError("file is required");
            const target = await resolveExistingWorkspaceFile(outboxRoot, file);
            res.download(target, path.basename(target));
        }
        catch (error) {
            res.status(fileErrorStatus(error)).json({ ok: false, error: errorMessage(error) });
        }
    });
}
//# sourceMappingURL=inspect.js.map