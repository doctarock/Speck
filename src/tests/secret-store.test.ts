import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretStore } from "../security/secret-store.js";

test("secret store encrypts values and exposes only handle metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speck-secrets-"));
  const store = new SecretStore(directory);
  try {
    const saved = await store.set("service.api-key", "correct horse battery staple");
    assert.equal(saved.handle, "service.api-key");
    assert.equal(await store.has("service.api-key"), true);
    assert.equal(await store.get("service.api-key"), "correct horse battery staple");
    assert.deepEqual((await store.list()).map((entry) => entry.handle), ["service.api-key"]);
    const persisted = await fs.readFile(path.join(directory, "secrets", "secrets.json"), "utf8");
    assert.equal(persisted.includes("correct horse battery staple"), false);
    assert.equal(await store.delete("service.api-key"), true);
    assert.equal(await store.get("service.api-key"), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("secret store rejects unsafe handles and empty values", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speck-secrets-"));
  const store = new SecretStore(directory);
  try {
    await assert.rejects(() => store.set("../escape", "value"), /secret handle/);
    await assert.rejects(() => store.set("safe.handle", ""), /must not be empty/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
