import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
/** Host-owned encrypted secrets. Values are never returned by list operations or HTTP routes. */
export class SecretStore {
    directory;
    keyPath;
    dataPath;
    key = null;
    constructor(runtimeRoot) {
        this.directory = path.join(runtimeRoot, "secrets");
        this.keyPath = path.join(this.directory, "master.key");
        this.dataPath = path.join(this.directory, "secrets.json");
    }
    async list() {
        const data = await this.loadData();
        return Object.entries(data.secrets)
            .map(([handle, secret]) => ({ handle, updatedAt: secret.updatedAt }))
            .sort((a, b) => a.handle.localeCompare(b.handle));
    }
    async has(handle) {
        return Boolean((await this.loadData()).secrets[normalizeHandle(handle)]);
    }
    async set(handle, value) {
        const normalized = normalizeHandle(handle);
        if (typeof value !== "string" || value.length === 0)
            throw new TypeError("secret value must not be empty");
        if (Buffer.byteLength(value, "utf8") > 64 * 1024)
            throw new TypeError("secret value exceeds 64 KiB");
        const [data, key] = await Promise.all([this.loadData(), this.loadKey()]);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        const updatedAt = new Date().toISOString();
        data.secrets[normalized] = {
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            ciphertext: ciphertext.toString("base64"),
            updatedAt
        };
        await this.saveData(data);
        return { handle: normalized, updatedAt };
    }
    /** For trusted host capabilities only. Do not expose this value through an HTTP response or model tool. */
    async get(handle) {
        const normalized = normalizeHandle(handle);
        const record = (await this.loadData()).secrets[normalized];
        if (!record)
            return null;
        const decipher = crypto.createDecipheriv("aes-256-gcm", await this.loadKey(), Buffer.from(record.iv, "base64"));
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        return Buffer.concat([
            decipher.update(Buffer.from(record.ciphertext, "base64")),
            decipher.final()
        ]).toString("utf8");
    }
    async delete(handle) {
        const normalized = normalizeHandle(handle);
        const data = await this.loadData();
        if (!data.secrets[normalized])
            return false;
        delete data.secrets[normalized];
        await this.saveData(data);
        return true;
    }
    async loadKey() {
        if (this.key)
            return this.key;
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        try {
            const encoded = (await fs.readFile(this.keyPath, "utf8")).trim();
            const key = Buffer.from(encoded, "base64");
            if (key.length !== 32)
                throw new Error("secret master key is invalid");
            this.key = key;
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            const key = crypto.randomBytes(32);
            await fs.writeFile(this.keyPath, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            this.key = key;
        }
        return this.key;
    }
    async loadData() {
        try {
            const parsed = JSON.parse(await fs.readFile(this.dataPath, "utf8"));
            if (parsed?.version !== 1 || !parsed.secrets || typeof parsed.secrets !== "object")
                throw new Error("secret store is invalid");
            return parsed;
        }
        catch (error) {
            if (isMissing(error))
                return { version: 1, secrets: {} };
            throw error;
        }
    }
    async saveData(data) {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.dataPath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, this.dataPath);
    }
}
function normalizeHandle(value) {
    const handle = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(handle)) {
        throw new TypeError("secret handle must be 2-64 lowercase letters, numbers, dots, underscores, or hyphens and start with a letter");
    }
    return handle;
}
function isMissing(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
//# sourceMappingURL=secret-store.js.map