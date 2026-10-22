import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingRuntimeConfig } from "../config.js";
import { featureHashEmbedding } from "../background/maintenance.js";
import { EmbeddingClient } from "../memory/embedding.js";

const INDEX_VERSION = 1;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2_000_000;
const CHUNK_CHARS = 1_200;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS_PER_FILE = 64;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".mdx", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".html", ".htm",
  ".yaml", ".yml", ".toml", ".ini", ".log", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".css", ".scss", ".sql", ".py", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".sh", ".ps1"
]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache"]);

interface IndexedChunk {
  id: string;
  file: string;
  index: number;
  content: string;
  vector: number[];
}

interface IndexedDocument {
  file: string;
  size: number;
  modifiedAt: number;
  hash: string;
  chunks: IndexedChunk[];
}

interface WorkspaceIndexFile {
  version: number;
  provider: string;
  model: string;
  dimensions: number;
  updatedAt: string;
  documents: IndexedDocument[];
}

export class WorkspaceKnowledgeIndex {
  private readonly embeddings = new EmbeddingClient();

  constructor(private readonly workspaceRoot: string, private readonly indexPath: string) {}

  async index(config: EmbeddingRuntimeConfig): Promise<{ files: number; chunks: number; changed: number; removed: number; fallback: boolean }> {
    const root = await fs.realpath(this.workspaceRoot);
    const previous = await this.readIndex();
    const compatible = previous.provider === config.provider && previous.model === config.model && previous.dimensions === config.dimensions;
    const oldByFile = new Map((compatible ? previous.documents : []).map((document) => [document.file, document]));
    const discovered = await discoverTextFiles(root);
    const documents: IndexedDocument[] = [];
    let changed = 0;
    let fallback = false;
    for (const item of discovered) {
      const content = await fs.readFile(item.absolute, "utf8");
      const hash = sha256(content);
      const prior = oldByFile.get(item.file);
      if (prior?.hash === hash) {
        documents.push(prior);
        oldByFile.delete(item.file);
        continue;
      }
      const texts = chunkText(content);
      const encoded = await encode(config, this.embeddings, texts);
      fallback ||= encoded.fallback;
      documents.push({
        file: item.file, size: item.size, modifiedAt: item.modifiedAt, hash,
        chunks: texts.map((text, index) => ({ id: sha256(`${item.file}:${index}:${hash}`).slice(0, 24), file: item.file, index, content: text, vector: encoded.vectors[index]! }))
      });
      changed += 1;
      oldByFile.delete(item.file);
    }
    if (fallback) {
      for (const document of documents) {
        for (const chunk of document.chunks) chunk.vector = featureHashEmbedding(chunk.content, config.dimensions);
      }
    }
    const next: WorkspaceIndexFile = {
      version: INDEX_VERSION,
      provider: fallback ? "feature-hash" : config.provider,
      model: fallback ? "speck-feature-hash-v1" : config.model,
      dimensions: documents[0]?.chunks[0]?.vector.length ?? config.dimensions,
      updatedAt: new Date().toISOString(),
      documents: documents.sort((left, right) => left.file.localeCompare(right.file))
    };
    await writeJsonAtomic(this.indexPath, next);
    return { files: next.documents.length, chunks: next.documents.reduce((sum, document) => sum + document.chunks.length, 0), changed, removed: oldByFile.size, fallback };
  }

  async search(config: EmbeddingRuntimeConfig, queryValue: unknown, limitValue: unknown): Promise<{ query: string; matches: Array<Record<string, unknown>>; indexedAt: string | null }> {
    const query = String(queryValue ?? "").trim();
    if (!query) throw new TypeError("document_search requires a query");
    if (query.length > 500) throw new RangeError("document_search query is limited to 500 characters");
    const index = await this.readIndex();
    if (!index.documents.length) return { query, matches: [], indexedAt: null };
    const limit = boundedInteger(limitValue, 8, 1, 30);
    if (index.provider !== "feature-hash" && (index.provider !== config.provider || index.model !== config.model)) {
      throw new Error("Workspace index embedding model changed; run document_index again");
    }
    const vector = index.provider === "feature-hash"
      ? featureHashEmbedding(query, index.dimensions)
      : (await encode(config, this.embeddings, [query], "query")).vectors[0]!;
    if (vector.length !== index.dimensions) throw new Error("Workspace index embedding dimensions changed; run document_index again");
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
    const matches = index.documents.flatMap((document) => document.chunks.map((chunk) => {
      const semantic = dot(vector, chunk.vector);
      const lower = chunk.content.toLowerCase();
      const lexical = terms.length ? terms.filter((term) => lower.includes(term)).length / terms.length : 0;
      return { file: document.file, chunk: chunk.index, score: semantic * 0.9 + lexical * 0.1, semanticScore: semantic, excerpt: chunk.content.slice(0, 1_200) };
    })).sort((left, right) => right.score - left.score || left.file.localeCompare(right.file)).slice(0, limit);
    return { query, matches, indexedAt: index.updatedAt || null };
  }

  async status(): Promise<{ files: number; chunks: number; updatedAt: string | null; provider: string; model: string }> {
    const index = await this.readIndex();
    return {
      files: index.documents.length,
      chunks: index.documents.reduce((sum, document) => sum + document.chunks.length, 0),
      updatedAt: index.updatedAt || null,
      provider: index.provider,
      model: index.model
    };
  }

  private async readIndex(): Promise<WorkspaceIndexFile> {
    try {
      const value = JSON.parse(await fs.readFile(this.indexPath, "utf8")) as Partial<WorkspaceIndexFile>;
      return {
        version: Number(value.version ?? INDEX_VERSION), provider: String(value.provider ?? ""), model: String(value.model ?? ""),
        dimensions: Number(value.dimensions ?? 0), updatedAt: String(value.updatedAt ?? ""),
        documents: Array.isArray(value.documents) ? value.documents : []
      };
    } catch (error) {
      if (isMissing(error)) return { version: INDEX_VERSION, provider: "", model: "", dimensions: 0, updatedAt: "", documents: [] };
      throw error;
    }
  }
}

async function discoverTextFiles(root: string): Promise<Array<{ absolute: string; file: string; size: number; modifiedAt: number }>> {
  const output: Array<{ absolute: string; file: string; size: number; modifiedAt: number }> = [];
  const queue = [root];
  while (queue.length && output.length < MAX_FILES) {
    const directory = queue.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (output.length >= MAX_FILES || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_FILE_BYTES) continue;
      output.push({ absolute, file: path.relative(root, absolute).replaceAll("\\", "/"), size: stat.size, modifiedAt: stat.mtimeMs });
    }
  }
  return output;
}

function chunkText(value: string): string[] {
  const text = value.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    let end = Math.min(text.length, offset + CHUNK_CHARS);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (boundary > offset + CHUNK_CHARS / 2) end = boundary;
    }
    chunks.push(text.slice(offset, end).trim());
    if (end >= text.length) break;
    offset = Math.max(offset + 1, end - CHUNK_OVERLAP);
  }
  return chunks.filter(Boolean);
}

async function encode(config: EmbeddingRuntimeConfig, client: EmbeddingClient, texts: string[], purpose: "query" | "document" = "document"): Promise<{ vectors: number[][]; fallback: boolean }> {
  if (!texts.length) return { vectors: [], fallback: false };
  if (config.enabled) {
    try {
      const vectors: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += config.batchSize) {
        vectors.push(...await client.embed(config, texts.slice(offset, offset + config.batchSize), purpose));
      }
      return { vectors, fallback: false };
    } catch (error) {
      if (!config.allowHashFallback) throw error;
    }
  }
  return { vectors: texts.map((text) => featureHashEmbedding(text, config.dimensions)), fallback: true };
}

function dot(left: number[], right: number[]): number {
  let total = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) total += left[index]! * right[index]!;
  return total;
}

function sha256(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, target);
}
