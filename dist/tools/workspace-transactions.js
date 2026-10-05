import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
export class WorkspaceTransactionManager {
    workspaceRoot;
    stateRoot;
    constructor(workspaceRoot, stateRoot) {
        this.workspaceRoot = workspaceRoot;
        this.stateRoot = stateRoot;
    }
    async preview(value) {
        if (!Array.isArray(value) || !value.length)
            throw new TypeError("workspace_transaction_preview requires a non-empty changes array");
        if (value.length > 50)
            throw new RangeError("A workspace transaction is limited to 50 files");
        const root = await fs.realpath(this.workspaceRoot);
        const seen = new Set();
        const changes = [];
        for (const entry of value) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
                throw new TypeError("Each transaction change must be an object");
            const input = entry;
            const file = normalizedRelativePath(input.file);
            if (seen.has(file.toLowerCase()))
                throw new TypeError(`Duplicate transaction target: ${file}`);
            seen.add(file.toLowerCase());
            const operation = String(input.operation ?? "write");
            if (!["write", "delete"].includes(operation))
                throw new TypeError(`Unsupported operation for ${file}: ${operation}`);
            const target = confinedTarget(root, file);
            const original = await fs.readFile(target).catch((error) => isMissing(error) ? null : Promise.reject(error));
            if (original && original.byteLength > 5_000_000)
                throw new RangeError(`${file} exceeds the 5 MB transaction limit`);
            if (operation === "delete" && !original)
                throw new TypeError(`Cannot delete missing file: ${file}`);
            const content = operation === "write" ? String(input.content ?? "") : null;
            const desired = content === null ? null : Buffer.from(content, "utf8");
            if (desired && desired.byteLength > 5_000_000)
                throw new RangeError(`${file} exceeds the 5 MB transaction limit`);
            const originalHash = original ? sha256(original) : null;
            const desiredHash = desired ? sha256(desired) : null;
            const status = operation === "delete" ? "delete" : !original ? "create" : originalHash === desiredHash ? "unchanged" : "replace";
            changes.push({
                file, operation, content, existed: Boolean(original), originalHash, desiredHash,
                originalBytes: original?.byteLength ?? 0, desiredBytes: desired?.byteLength ?? 0,
                summary: `${status}: ${file} (${original?.byteLength ?? 0} -> ${desired?.byteLength ?? 0} bytes)`
            });
        }
        const manifest = {
            id: crypto.randomUUID(), status: "prepared", createdAt: new Date().toISOString(), appliedAt: null, rolledBackAt: null, changes
        };
        await writeJsonAtomic(this.manifestPath(manifest.id), manifest);
        return publicManifest(manifest);
    }
    async apply(idValue) {
        const manifest = await this.readManifest(idValue);
        if (manifest.status !== "prepared")
            throw new TypeError(`Transaction ${manifest.id} is ${manifest.status}, not prepared`);
        const root = await fs.realpath(this.workspaceRoot);
        for (const change of manifest.changes) {
            const target = confinedTarget(root, change.file);
            const current = await fs.readFile(target).catch((error) => isMissing(error) ? null : Promise.reject(error));
            const currentHash = current ? sha256(current) : null;
            if (currentHash !== change.originalHash)
                throw new Error(`Workspace changed after preview: ${change.file}`);
        }
        const applied = [];
        try {
            for (const change of manifest.changes) {
                const target = confinedTarget(root, change.file);
                const backup = this.backupPath(manifest.id, change.file);
                if (change.existed) {
                    await fs.mkdir(path.dirname(backup), { recursive: true });
                    await fs.copyFile(target, backup);
                }
                if (change.operation === "delete")
                    await fs.unlink(target);
                else {
                    await fs.mkdir(path.dirname(target), { recursive: true });
                    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
                    try {
                        await fs.writeFile(temporary, change.content ?? "", { encoding: "utf8", flag: "wx" });
                        await fs.copyFile(temporary, target);
                    }
                    finally {
                        await fs.unlink(temporary).catch(() => undefined);
                    }
                }
                applied.push(change);
            }
        }
        catch (error) {
            await this.restoreChanges(root, manifest.id, applied.reverse());
            throw error;
        }
        manifest.status = "applied";
        manifest.appliedAt = new Date().toISOString();
        await writeJsonAtomic(this.manifestPath(manifest.id), manifest);
        return publicManifest(manifest);
    }
    async rollback(idValue) {
        const manifest = await this.readManifest(idValue);
        if (manifest.status !== "applied")
            throw new TypeError(`Transaction ${manifest.id} is ${manifest.status}, not applied`);
        const root = await fs.realpath(this.workspaceRoot);
        await this.restoreChanges(root, manifest.id, [...manifest.changes].reverse());
        manifest.status = "rolled_back";
        manifest.rolledBackAt = new Date().toISOString();
        await writeJsonAtomic(this.manifestPath(manifest.id), manifest);
        return publicManifest(manifest);
    }
    async restoreChanges(root, id, changes) {
        for (const change of changes) {
            const target = confinedTarget(root, change.file);
            if (change.existed) {
                const backup = this.backupPath(id, change.file);
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.copyFile(backup, target);
            }
            else {
                await fs.unlink(target).catch((error) => { if (!isMissing(error))
                    throw error; });
            }
        }
    }
    async readManifest(idValue) {
        const id = String(idValue ?? "").trim();
        if (!/^[0-9a-f-]{36}$/i.test(id))
            throw new TypeError("A valid transactionId is required");
        return JSON.parse(await fs.readFile(this.manifestPath(id), "utf8"));
    }
    manifestPath(id) { return path.join(this.stateRoot, `${id}.json`); }
    backupPath(id, file) { return path.join(this.stateRoot, id, "backups", ...file.split("/")); }
}
function normalizedRelativePath(value) {
    const normalized = String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new TypeError("Transaction file paths must be confined relative workspace paths");
    }
    return normalized;
}
function confinedTarget(root, file) {
    const target = path.resolve(root, ...file.split("/"));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new TypeError("Transaction target escapes the workspace");
    return target;
}
function publicManifest(manifest) {
    return {
        transactionId: manifest.id, status: manifest.status, createdAt: manifest.createdAt,
        appliedAt: manifest.appliedAt, rolledBackAt: manifest.rolledBackAt,
        changes: manifest.changes.map(({ content: _content, ...change }) => change)
    };
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function isMissing(error) { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
async function writeJsonAtomic(target, value) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
}
//# sourceMappingURL=workspace-transactions.js.map