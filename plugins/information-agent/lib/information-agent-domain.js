import crypto from "node:crypto";

const DEFAULT_SCAN_INTERVAL_MINUTES = 30;
const MAX_UPDATES = 250;
const SOURCE_TYPES = new Set(["blog", "news", "social", "finance", "shopping", "web"]);

function nowMs() {
  return Date.now();
}

function compactText(value = "", maxLength = 800) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function slugify(value = "", fallback = "item") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function hashText(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function toList(value = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[,;\n]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTimestamp(value = 0, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
}

function normalizeSourceType(value = "") {
  const type = String(value || "").trim().toLowerCase();
  return SOURCE_TYPES.has(type) ? type : "web";
}

function normalizeInterest(input = {}) {
  const createdAt = parseTimestamp(input.createdAt, nowMs()) || nowMs();
  const name = compactText(input.name || input.title || input.prompt || "Watched interest", 120);
  return {
    id: slugify(input.id || name || `interest-${createdAt}`, `interest-${createdAt}`),
    name,
    prompt: compactText(input.prompt || input.description || name, 1200),
    keywords: toList(input.keywords),
    categories: toList(input.categories),
    priority: Math.max(1, Math.min(Number(input.priority || 3) || 3, 5)),
    enabled: input.enabled !== false,
    digestStyle: compactText(input.digestStyle || "Concise, practical, and focused on what changed.", 300),
    createdAt,
    updatedAt: parseTimestamp(input.updatedAt, createdAt) || createdAt
  };
}

function normalizeSource(input = {}) {
  const createdAt = parseTimestamp(input.createdAt, nowMs()) || nowMs();
  const url = compactText(input.url || input.href || "", 1000);
  return {
    id: slugify(input.id || input.label || url || `source-${createdAt}`, `source-${createdAt}`),
    interestId: slugify(input.interestId || input.monitorId || "", ""),
    type: normalizeSourceType(input.type),
    label: compactText(input.label || input.name || url || "Source", 160),
    url,
    selector: compactText(input.selector || "", 220),
    useBrowser: input.useBrowser === true,
    enabled: input.enabled !== false,
    intervalMinutes: Math.max(5, Math.min(Number(input.intervalMinutes || DEFAULT_SCAN_INTERVAL_MINUTES) || DEFAULT_SCAN_INTERVAL_MINUTES, 24 * 60)),
    lastScanAt: parseTimestamp(input.lastScanAt, 0),
    lastChangedAt: parseTimestamp(input.lastChangedAt, 0),
    lastHash: String(input.lastHash || "").trim(),
    lastSignal: input.lastSignal && typeof input.lastSignal === "object" ? input.lastSignal : null,
    lastError: compactText(input.lastError || "", 500),
    createdAt,
    updatedAt: parseTimestamp(input.updatedAt, createdAt) || createdAt
  };
}

function normalizeUpdate(input = {}) {
  const createdAt = parseTimestamp(input.createdAt, nowMs()) || nowMs();
  return {
    id: slugify(input.id || `update-${createdAt}`, `update-${createdAt}`),
    interestId: slugify(input.interestId || "", ""),
    sourceId: slugify(input.sourceId || "", ""),
    sourceType: normalizeSourceType(input.sourceType),
    sourceLabel: compactText(input.sourceLabel || "", 160),
    sourceUrl: compactText(input.sourceUrl || "", 1000),
    title: compactText(input.title || "Information update", 180),
    summary: compactText(input.summary || "", 1600),
    importance: Math.max(1, Math.min(Number(input.importance || 2) || 2, 5)),
    changeType: compactText(input.changeType || "content-change", 80),
    evidence: Array.isArray(input.evidence) ? input.evidence.map((entry) => compactText(entry, 320)).filter(Boolean).slice(0, 6) : [],
    acknowledged: input.acknowledged === true,
    createdAt
  };
}

function normalizeState(state = {}) {
  const interests = Array.isArray(state.interests)
    ? state.interests.map(normalizeInterest).filter((entry) => entry.id)
    : [];
  const validInterestIds = new Set(interests.map((entry) => entry.id));
  const sources = Array.isArray(state.sources)
    ? state.sources.map(normalizeSource).filter((entry) => entry.id && entry.url && validInterestIds.has(entry.interestId))
    : [];
  const updates = Array.isArray(state.updates)
    ? state.updates.map(normalizeUpdate).filter((entry) => entry.id).slice(0, MAX_UPDATES)
    : [];
  return { version: 1, interests, sources, updates };
}

function stripHtml(html = "") {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(html = "", pattern) {
  const match = String(html || "").match(pattern);
  return compactText(match?.[1] || "", 260);
}

function extractPrices(text = "") {
  const matches = [];
  const pricePattern = /(?:[$\u00a3\u20ac]|AUD|USD|EUR|GBP)\s?\d{1,6}(?:[,.]\d{2})?/gi;
  for (const match of String(text || "").matchAll(pricePattern)) {
    const value = compactText(match[0], 40);
    if (!matches.includes(value)) matches.push(value);
    if (matches.length >= 8) break;
  }
  return matches;
}

function extractSignal(raw = "", source = {}) {
  const content = String(raw || "");
  const isHtml = /<\/?[a-z][\s\S]*>/i.test(content);
  const title = isHtml ? extractTag(content, /<title[^>]*>([\s\S]*?)<\/title>/i) : "";
  const description = isHtml
    ? extractTag(content, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)
    : "";
  const text = compactText(isHtml ? stripHtml(content) : content, 7000);
  const selectedText = source.selector ? text : text;
  return {
    title: title || compactText(selectedText.split(/[.!?]\s/)[0] || source.label || "Source", 180),
    description,
    text: selectedText,
    prices: extractPrices(selectedText),
    capturedAt: nowMs()
  };
}

function countKeywordHits(signal = {}, interest = {}) {
  const haystack = `${signal.title || ""}\n${signal.description || ""}\n${signal.text || ""}`.toLowerCase();
  const keywords = [
    ...toList(interest.keywords),
    ...toList(interest.categories)
  ].map((entry) => entry.toLowerCase());
  return keywords.filter((keyword) => keyword && haystack.includes(keyword)).length;
}

function buildEvidence(previous = null, next = {}, interest = {}, source = {}) {
  const evidence = [];
  const keywordHits = countKeywordHits(next, interest);
  if (keywordHits) evidence.push(`${keywordHits} watched keyword match${keywordHits === 1 ? "" : "es"} found.`);
  if (previous?.title && next.title && previous.title !== next.title) {
    evidence.push(`Title changed from "${compactText(previous.title, 90)}" to "${compactText(next.title, 90)}".`);
  }
  const oldPrices = Array.isArray(previous?.prices) ? previous.prices : [];
  const newPrices = Array.isArray(next.prices) ? next.prices : [];
  const addedPrices = newPrices.filter((price) => !oldPrices.includes(price));
  if (addedPrices.length) evidence.push(`New price signals: ${addedPrices.slice(0, 4).join(", ")}.`);
  if (source.type === "finance" && /\b(up|down|gain|loss|earnings|guidance|dividend|price target)\b/i.test(next.text || "")) {
    evidence.push("Finance language changed around price, earnings, guidance, or market movement.");
  }
  if (source.type === "shopping" && /\b(sale|discount|back in stock|sold out|limited|deal|coupon)\b/i.test(next.text || "")) {
    evidence.push("Shopping language changed around stock, discount, or deal terms.");
  }
  if (!evidence.length) evidence.push("The source content hash changed since the last scan.");
  return evidence.slice(0, 6);
}

function summarizeUpdate(previous = null, next = {}, interest = {}, source = {}) {
  const evidence = buildEvidence(previous, next, interest, source);
  const focus = interest.prompt || interest.name || "your watch";
  const sourceName = source.label || source.url || "source";
  const topText = next.description || next.title || compactText(next.text, 180);
  const summary = [
    `${sourceName} changed in a way that may matter for ${focus}.`,
    topText ? `Current signal: ${compactText(topText, 260)}` : "",
    evidence.length ? `Why it was flagged: ${evidence.join(" ")}` : ""
  ].filter(Boolean).join(" ");
  const keywordHits = countKeywordHits(next, interest);
  const importance = Math.max(1, Math.min(5, Number(interest.priority || 3) + Math.min(keywordHits, 2) - (previous ? 0 : 1)));
  return {
    title: `${source.type === "web" ? "Web" : source.type} update: ${next.title || source.label || interest.name}`,
    summary,
    importance,
    evidence
  };
}

export function createInformationAgentDomain({
  dataApi = null,
  broadcast = () => {}
} = {}) {
  const stateKey = "information-agent-state";

  async function readState() {
    if (!dataApi) return normalizeState();
    return normalizeState(await dataApi.readJson(stateKey, {}));
  }

  async function writeState(state = {}) {
    const normalized = normalizeState(state);
    if (dataApi) await dataApi.writeJson(stateKey, normalized);
    return normalized;
  }

  async function listState() {
    const state = await readState();
    return {
      ...state,
      summary: {
        interestCount: state.interests.length,
        sourceCount: state.sources.length,
        updateCount: state.updates.length,
        unacknowledgedCount: state.updates.filter((entry) => !entry.acknowledged).length,
        dueSourceCount: state.sources.filter((source) => source.enabled && (!source.lastScanAt || nowMs() - source.lastScanAt >= source.intervalMinutes * 60 * 1000)).length
      }
    };
  }

  async function saveInterest(input = {}) {
    const state = await readState();
    const next = normalizeInterest({ ...input, updatedAt: nowMs() });
    const index = state.interests.findIndex((entry) => entry.id === next.id);
    if (index >= 0) state.interests[index] = { ...state.interests[index], ...next };
    else state.interests.push(next);
    await writeState(state);
    return next;
  }

  async function saveSource(input = {}) {
    const state = await readState();
    const next = normalizeSource({ ...input, updatedAt: nowMs() });
    if (!next.interestId) throw new Error("interestId is required");
    if (!state.interests.some((entry) => entry.id === next.interestId)) throw new Error("interest not found");
    if (!next.url) throw new Error("url is required");
    const index = state.sources.findIndex((entry) => entry.id === next.id);
    if (index >= 0) state.sources[index] = { ...state.sources[index], ...next };
    else state.sources.push(next);
    await writeState(state);
    return next;
  }

  async function acknowledgeUpdate(updateId = "", acknowledged = true) {
    const state = await readState();
    const id = String(updateId || "").trim();
    const update = state.updates.find((entry) => entry.id === id);
    if (!update) throw new Error("update not found");
    update.acknowledged = acknowledged !== false;
    await writeState(state);
    return update;
  }

  async function scanSource(sourceId = "", {
    fetchText,
    emitBaseline = false
  } = {}) {
    if (typeof fetchText !== "function") throw new Error("fetchText function is required");
    const state = await readState();
    const source = state.sources.find((entry) => entry.id === String(sourceId || "").trim());
    if (!source) throw new Error("source not found");
    const interest = state.interests.find((entry) => entry.id === source.interestId);
    if (!interest) throw new Error("interest not found");
    const raw = await fetchText(source);
    const nextSignal = extractSignal(raw, source);
    const nextHash = hashText(`${nextSignal.title}\n${nextSignal.description}\n${nextSignal.text}`);
    const previousSignal = source.lastSignal || null;
    const changed = Boolean(source.lastHash && source.lastHash !== nextHash);
    const baseline = !source.lastHash;
    source.lastScanAt = nowMs();
    source.lastError = "";
    source.lastHash = nextHash;
    source.lastSignal = nextSignal;
    let update = null;
    if (changed || (baseline && emitBaseline)) {
      source.lastChangedAt = nowMs();
      const synthesized = summarizeUpdate(previousSignal, nextSignal, interest, source);
      update = normalizeUpdate({
        id: `info-${source.id}-${source.lastChangedAt}`,
        interestId: interest.id,
        sourceId: source.id,
        sourceType: source.type,
        sourceLabel: source.label,
        sourceUrl: source.url,
        changeType: baseline ? "baseline" : "content-change",
        ...synthesized,
        createdAt: source.lastChangedAt
      });
      state.updates.unshift(update);
      state.updates = state.updates.slice(0, MAX_UPDATES);
    }
    await writeState(state);
    if (update) {
      broadcast({ type: "information-agent.update", update, interest, source });
    }
    return { source, interest, changed, baseline, update };
  }

  async function runDueScans({
    fetchText,
    limit = 8,
    emitBaseline = false,
    includeNotDue = false
  } = {}) {
    const state = await readState();
    const current = nowMs();
    const candidates = state.sources
      .filter((source) => source.enabled)
      .filter((source) => state.interests.some((interest) => interest.id === source.interestId && interest.enabled))
      .filter((source) => includeNotDue || !source.lastScanAt || current - source.lastScanAt >= source.intervalMinutes * 60 * 1000)
      .slice(0, Math.max(1, Math.min(Number(limit || 8) || 8, 50)));
    const results = [];
    for (const source of candidates) {
      try {
        results.push(await scanSource(source.id, { fetchText, emitBaseline }));
      } catch (error) {
        const latest = await readState();
        const failed = latest.sources.find((entry) => entry.id === source.id);
        if (failed) {
          failed.lastScanAt = nowMs();
          failed.lastError = compactText(String(error?.message || error || "scan failed"), 500);
          await writeState(latest);
        }
        results.push({ source, changed: false, error: String(error?.message || error || "scan failed") });
      }
    }
    return {
      scannedCount: results.length,
      changedCount: results.filter((entry) => entry.changed).length,
      updateCount: results.filter((entry) => entry.update).length,
      results
    };
  }

  return {
    acknowledgeUpdate,
    listState,
    normalizeState,
    readState,
    runDueScans,
    saveInterest,
    saveSource,
    scanSource,
    writeState
  };
}
