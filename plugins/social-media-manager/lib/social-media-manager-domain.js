const DEFAULT_PLATFORMS = [
  {
    id: "reddit",
    name: "Reddit",
    url: "https://www.reddit.com/search/?q={query}",
    strengths: ["community discussion", "niche discovery", "question answering"],
    risk: "high",
    fitKeywords: ["developer", "gaming", "ai", "tool", "software", "hobby", "community"]
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    url: "https://www.linkedin.com/search/results/content/?keywords={query}",
    strengths: ["professional credibility", "B2B reach", "founder updates"],
    risk: "medium",
    fitKeywords: ["business", "b2b", "professional", "saas", "consulting", "career", "enterprise"]
  },
  {
    id: "product-hunt",
    name: "Product Hunt",
    url: "https://www.producthunt.com/search?q={query}",
    strengths: ["launch discovery", "maker feedback", "early adopters"],
    risk: "medium",
    fitKeywords: ["startup", "app", "software", "tool", "productivity", "ai", "maker"]
  },
  {
    id: "hacker-news",
    name: "Hacker News",
    url: "https://hn.algolia.com/?q={query}",
    strengths: ["technical buyers", "critical feedback", "engineering audience"],
    risk: "high",
    fitKeywords: ["developer", "engineering", "technical", "open source", "security", "ai"]
  },
  {
    id: "indie-hackers",
    name: "Indie Hackers",
    url: "https://www.indiehackers.com/search?q={query}",
    strengths: ["founder audience", "build-in-public", "growth feedback"],
    risk: "medium",
    fitKeywords: ["startup", "founder", "bootstrapped", "saas", "marketing", "creator"]
  },
  {
    id: "x",
    name: "X",
    url: "https://x.com/search?q={query}&src=typed_query",
    strengths: ["fast experiments", "public threads", "creator networking"],
    risk: "medium",
    fitKeywords: ["creator", "startup", "ai", "design", "news", "marketing", "tool"]
  },
  {
    id: "facebook-groups",
    name: "Facebook Groups",
    url: "https://www.facebook.com/search/groups/?q={query}",
    strengths: ["local groups", "consumer communities", "support threads"],
    risk: "high",
    fitKeywords: ["local", "consumer", "parent", "hobby", "community", "service"]
  },
  {
    id: "tiktok",
    name: "TikTok",
    url: "https://www.tiktok.com/search?q={query}",
    strengths: ["short demos", "consumer discovery", "visual storytelling"],
    risk: "medium",
    fitKeywords: ["visual", "consumer", "fashion", "food", "fitness", "home", "creator"]
  },
  {
    id: "facebook",
    name: "Facebook Page",
    url: "https://www.facebook.com/search/pages/?q={query}",
    strengths: ["local customers", "page followers", "event and offer posts"],
    risk: "low",
    fitKeywords: ["local", "consumer", "store", "service", "community", "events"]
  },
  {
    id: "instagram",
    name: "Instagram",
    url: "https://www.instagram.com/explore/search/keyword/?q={query}",
    strengths: ["visual products", "behind the scenes", "local discovery"],
    risk: "low",
    fitKeywords: ["visual", "consumer", "design", "maker", "food", "fashion", "home"]
  }
];

const DEFAULT_PROPERTY_ID = "default";

export function listPlatformCatalog() {
  return DEFAULT_PLATFORMS.map(({ id, name, strengths, risk }) => ({ id, name, strengths: strengths.slice(), risk }));
}

function platformId(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const found = DEFAULT_PLATFORMS.find((entry) => entry.id === normalized || entry.name.toLowerCase() === normalized);
  return found?.id || slugify(normalized, "");
}

function compactText(value = "", maxLength = 500) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

// Post and reply text keeps its line breaks; only runs of spaces and of
// blank lines are collapsed.
function compactParagraphs(value = "", maxLength = 4000) {
  const normalized = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function slugify(value = "", fallback = "item") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function asArray(value = []) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .split(/[,;\n]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function uniqueStrings(values = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of asArray(values)) {
    const normalized = compactText(value, 80);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function parseTimestamp(value = null, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const text = String(value || "").trim();
  if (!text) {
    return Number(fallback || 0);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
}

function normalizeStatus(value = "", allowed = [], fallback = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeChannel(record = {}) {
  const source = typeof record === "string" ? { platform: record } : record || {};
  const platform = platformId(source.platform || source.id || source.name || "");
  return {
    platform,
    label: compactText(source.label || platformName(platform), 120),
    handle: compactText(source.handle || source.accountId || "", 160),
    enabled: source.enabled !== false,
    notes: compactText(source.notes || "", 600)
  };
}

function normalizeChannels(value = []) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(value) ? value : asArray(value)) {
    const channel = normalizeChannel(entry);
    if (!channel.platform || seen.has(channel.platform)) continue;
    seen.add(channel.platform);
    out.push(channel);
  }
  return out;
}

function normalizeProperty(record = {}) {
  const now = Date.now();
  const name = compactText(record.name || record.title || "", 160) || "Untitled property";
  return {
    id: propertyKey(record.id || name),
    name,
    website: compactText(record.website || record.url || "", 300),
    description: compactText(record.description || "", 1200),
    audience: compactText(record.audience || "", 600),
    voice: compactText(record.voice || record.tone || "", 300),
    keywords: uniqueStrings(record.keywords || []),
    guidelines: compactText(record.guidelines || record.constraints || "", 1500),
    channels: normalizeChannels(record.channels || record.platforms || []),
    status: normalizeStatus(record.status, ["active", "paused", "archived"], "active"),
    createdAt: Number(record.createdAt || now) || now,
    updatedAt: Number(record.updatedAt || record.createdAt || now) || now
  };
}

// A property's id is a short slug: it names the property's secrets, such as
// social.<id>.<platform>.webhook-url, which must fit Speck's 64-character handles.
function propertyKey(value = "") {
  return slugify(value, "property").slice(0, 24).replace(/-+$/g, "") || "property";
}

function uniquePropertyKey(state, value = "") {
  const base = propertyKey(value);
  const taken = new Set(state.properties.map((property) => property.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base.slice(0, 21)}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function uniqueRecordId(records = [], base = "item") {
  const taken = new Set(records.map((record) => record.id));
  const stem = compactText(base, 110);
  if (!taken.has(stem)) return stem;
  for (let index = 2; ; index += 1) {
    if (!taken.has(`${stem}-${index}`)) return `${stem}-${index}`;
  }
}

function enabledChannels(property = {}) {
  return (property.channels || []).filter((channel) => channel.enabled);
}

function normalizeProduct(record = {}) {
  const now = Date.now();
  const name = compactText(record.name || record.title || "", 160) || "Untitled product";
  const id = compactText(record.id || `product-${slugify(name)}-${now}`, 120);
  return {
    id,
    propertyId: compactText(record.propertyId || "", 120),
    name,
    url: compactText(record.url || record.productUrl || "", 300),
    description: compactText(record.description || "", 1200),
    audience: compactText(record.audience || record.targetAudience || "", 600),
    valueProposition: compactText(record.valueProposition || record.value || "", 600),
    keywords: uniqueStrings(record.keywords || record.tags || []),
    constraints: compactText(record.constraints || record.notes || "", 1000),
    sourceUrl: compactText(record.sourceUrl || record.url || "", 500),
    evidence: compactText(record.evidence || record.description || "", 1000),
    verifiedAt: Number(record.verifiedAt || record.updatedAt || record.createdAt || now) || now,
    status: normalizeStatus(record.status, ["active", "paused", "archived"], "active"),
    createdAt: Number(record.createdAt || now) || now,
    updatedAt: Number(record.updatedAt || record.createdAt || now) || now
  };
}

function normalizeOpportunity(record = {}) {
  const now = Date.now();
  const platform = compactText(record.platform || record.platformId || "web", 80).toLowerCase();
  const title = compactText(record.title || record.name || `${platform} opportunity`, 180);
  return {
    id: compactText(record.id || `opp-${slugify(platform)}-${slugify(title)}-${now}`, 140),
    propertyId: compactText(record.propertyId || "", 120),
    productId: compactText(record.productId || "", 140),
    platform,
    platformName: compactText(record.platformName || record.name || platform, 120),
    title,
    url: compactText(record.url || "", 500),
    audienceFit: compactText(record.audienceFit || record.fit || "", 700),
    postingGuidance: compactText(record.postingGuidance || record.guidance || "", 900),
    angle: compactText(record.angle || "", 400),
    searchQuery: compactText(record.searchQuery || "", 160),
    score: Math.max(0, Math.min(100, Math.round(Number(record.score || 0) || 0))),
    status: normalizeStatus(record.status, ["candidate", "approved", "rejected", "posted"], "candidate"),
    risk: normalizeStatus(record.risk, ["low", "medium", "high"], "medium"),
    createdAt: Number(record.createdAt || now) || now,
    updatedAt: Number(record.updatedAt || record.createdAt || now) || now
  };
}

function normalizePost(record = {}) {
  const now = Date.now();
  const body = compactParagraphs(record.body || record.text || record.content || "", 4000);
  return {
    id: compactText(record.id || `post-${now}-${Math.random().toString(36).slice(2, 8)}`, 140),
    propertyId: compactText(record.propertyId || "", 120),
    productId: compactText(record.productId || "", 140),
    opportunityId: compactText(record.opportunityId || "", 140),
    platform: platformId(record.platform || ""),
    title: compactText(record.title || "", 220),
    body,
    callToAction: compactText(record.callToAction || "", 300),
    url: compactText(record.url || "", 500),
    status: normalizeStatus(record.status, ["draft", "approved", "submitted", "published", "archived"], "draft"),
    publishedUrl: compactText(record.publishedUrl || "", 500),
    scheduledAt: parseTimestamp(record.scheduledAt, 0),
    publishedAt: parseTimestamp(record.publishedAt, 0),
    metrics: normalizeMetrics(record.metrics || {}),
    createdAt: Number(record.createdAt || now) || now,
    updatedAt: Number(record.updatedAt || record.createdAt || now) || now
  };
}

function normalizePublishingTarget(record = {}) {
  const now = Date.now();
  const platform = platformId(record.platform || record.service || "web");
  const accountId = compactText(record.accountId || record.account || "default", 100).toLowerCase();
  const label = compactText(record.label || record.name || `${platform} ${accountId}`, 160);
  return {
    id: compactText(record.id || `target-${slugify(platform)}-${slugify(accountId)}-${slugify(label)}`, 160),
    propertyId: compactText(record.propertyId || "", 120),
    platform,
    accountId,
    label,
    composerUrl: compactText(record.composerUrl || record.url || "", 600),
    openSelector: compactText(record.openSelector || "", 180),
    titleSelector: compactText(record.titleSelector || "", 180),
    bodySelector: compactText(record.bodySelector || record.textSelector || "", 180),
    nextSelector: compactText(record.nextSelector || "", 180),
    submitSelector: compactText(record.submitSelector || "", 180),
    publishedUrlSelector: compactText(record.publishedUrlSelector || "", 180),
    monitorTextSelector: compactText(record.monitorTextSelector || "body", 180),
    commentSelector: compactText(record.commentSelector || "", 180),
    commentAuthorSelector: compactText(record.commentAuthorSelector || "", 180),
    commentTextSelector: compactText(record.commentTextSelector || "", 180),
    replySelector: compactText(record.replySelector || "", 180),
    replySubmitSelector: compactText(record.replySubmitSelector || "", 180),
    status: normalizeStatus(record.status, ["active", "paused", "archived"], "active"),
    notes: compactText(record.notes || "", 1000),
    createdAt: Number(record.createdAt || now) || now,
    updatedAt: Number(record.updatedAt || record.createdAt || now) || now
  };
}

function normalizeMetrics(record = {}) {
  return {
    views: Math.max(0, Math.round(Number(record.views || 0) || 0)),
    likes: Math.max(0, Math.round(Number(record.likes || 0) || 0)),
    comments: Math.max(0, Math.round(Number(record.comments || 0) || 0)),
    shares: Math.max(0, Math.round(Number(record.shares || 0) || 0)),
    clicks: Math.max(0, Math.round(Number(record.clicks || 0) || 0))
  };
}

function normalizeInteraction(record = {}) {
  const now = Date.now();
  const text = compactParagraphs(record.text || record.commentText || record.body || "", 2400);
  return {
    id: compactText(record.id || `interaction-${now}-${Math.random().toString(36).slice(2, 8)}`, 140),
    propertyId: compactText(record.propertyId || "", 120),
    postId: compactText(record.postId || "", 140),
    productId: compactText(record.productId || "", 140),
    platform: compactText(record.platform || "", 80).toLowerCase(),
    author: compactText(record.author || record.commentAuthor || "", 160),
    text,
    sentiment: normalizeStatus(record.sentiment || inferSentiment(text), ["positive", "neutral", "negative", "question"], "neutral"),
    intent: compactText(record.intent || inferIntent(text), 120),
    replyDraft: compactParagraphs(record.replyDraft || "", 2400),
    replyStatus: normalizeStatus(record.replyStatus, ["needs-review", "approved", "replied", "ignored"], "needs-review"),
    externalUrl: compactText(record.externalUrl || record.url || "", 500),
    createdAt: Number(record.createdAt || now) || now,
    updatedAt: Number(record.updatedAt || record.createdAt || now) || now
  };
}

function normalizeState(state = {}) {
  return assignProperties({
    version: 2,
    properties: Array.isArray(state.properties) ? state.properties.map(normalizeProperty) : [],
    products: Array.isArray(state.products) ? state.products.map(normalizeProduct) : [],
    publishingTargets: Array.isArray(state.publishingTargets) ? state.publishingTargets.map(normalizePublishingTarget) : [],
    opportunities: Array.isArray(state.opportunities) ? state.opportunities.map(normalizeOpportunity) : [],
    posts: Array.isArray(state.posts) ? state.posts.map(normalizePost) : [],
    interactions: Array.isArray(state.interactions) ? state.interactions.map(normalizeInteraction) : []
  });
}

// Every product belongs to a property, and every record made from a product
// carries that product's property. Records saved before properties existed
// join the only property, or a default one.
function assignProperties(state) {
  const known = () => new Set(state.properties.map((property) => property.id));
  let ids = known();
  const fallback = () => {
    if (state.properties.length === 1) return state.properties[0].id;
    if (!ids.has(DEFAULT_PROPERTY_ID)) {
      state.properties.push(normalizeProperty({ id: DEFAULT_PROPERTY_ID, name: "Default property" }));
      ids = known();
    }
    return DEFAULT_PROPERTY_ID;
  };
  const productProperty = new Map();
  for (const product of state.products) {
    if (!ids.has(product.propertyId)) product.propertyId = fallback();
    productProperty.set(product.id, product.propertyId);
  }
  const postProperty = new Map();
  for (const kind of ["opportunities", "posts"]) {
    for (const record of state[kind]) {
      const fromProduct = productProperty.get(record.productId);
      if (fromProduct) record.propertyId = fromProduct;
      else if (!ids.has(record.propertyId)) record.propertyId = fallback();
      if (kind === "posts") postProperty.set(record.id, record.propertyId);
    }
  }
  for (const interaction of state.interactions) {
    const fromRecord = postProperty.get(interaction.postId) || productProperty.get(interaction.productId);
    if (fromRecord) interaction.propertyId = fromRecord;
    else if (!ids.has(interaction.propertyId)) interaction.propertyId = fallback();
  }
  for (const target of state.publishingTargets) {
    if (target.propertyId && !ids.has(target.propertyId)) target.propertyId = "";
  }
  return state;
}

function findProperty(state, reference = "") {
  const normalized = String(reference || "").trim().toLowerCase();
  if (!normalized) return null;
  return state.properties.find((property) => property.id.toLowerCase() === normalized)
    || state.properties.find((property) => property.name.toLowerCase() === normalized)
    || state.properties.find((property) => property.name.toLowerCase().includes(normalized))
    || null;
}

function propertyChoices(state) {
  return state.properties.map((property) => `${property.name} (${property.id})`).join(", ");
}

// The property a request is about: the one named, or the only one there is.
function resolveProperty(state, reference = "", { create = false } = {}) {
  const ref = String(reference || "").trim();
  if (ref) {
    const found = findProperty(state, ref);
    if (!found) throw new Error(`Property "${ref}" not found. Properties: ${propertyChoices(state) || "none saved"}.`);
    return found;
  }
  if (state.properties.length === 1) return state.properties[0];
  if (!state.properties.length && create) {
    const property = normalizeProperty({ id: DEFAULT_PROPERTY_ID, name: "Default property" });
    state.properties.push(property);
    return property;
  }
  if (!state.properties.length) throw new Error("Save a property before adding campaign records.");
  throw new Error(`Several properties exist; pass propertyId. Properties: ${propertyChoices(state)}.`);
}

function scopeToProperty(state, propertyId = "") {
  if (!propertyId) return state;
  const inProperty = (record) => record.propertyId === propertyId;
  return {
    ...state,
    properties: state.properties.filter((property) => property.id === propertyId),
    products: state.products.filter(inProperty),
    publishingTargets: state.publishingTargets.filter((target) => !target.propertyId || target.propertyId === propertyId),
    opportunities: state.opportunities.filter(inProperty),
    posts: state.posts.filter(inProperty),
    interactions: state.interactions.filter(inProperty)
  };
}

function inferSentiment(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/[?]/.test(lower) || /\b(how|what|why|when|where|can|does|is it|price|cost)\b/.test(lower)) {
    return "question";
  }
  if (/\b(bad|broken|spam|hate|scam|expensive|confusing|annoying)\b/.test(lower)) {
    return "negative";
  }
  if (/\b(great|love|nice|useful|thanks|awesome|helpful|interested)\b/.test(lower)) {
    return "positive";
  }
  return "neutral";
}

function inferIntent(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/\b(price|cost|pricing|free|paid|trial)\b/.test(lower)) return "pricing";
  if (/\b(how|setup|install|start|use)\b/.test(lower)) return "how-to";
  if (/\b(compare|alternative|versus|vs)\b/.test(lower)) return "comparison";
  if (/\b(bug|broken|issue|error)\b/.test(lower)) return "support";
  if (/\b(spam|self promo|promotion)\b/.test(lower)) return "moderation-risk";
  return "general";
}

function productSearchTerms(product = {}, extraKeywords = []) {
  return uniqueStrings([
    product.name,
    product.audience,
    product.valueProposition,
    ...asArray(product.keywords),
    ...asArray(extraKeywords)
  ].flatMap((entry) => String(entry || "").split(/[^a-zA-Z0-9]+/g)).filter((entry) => entry.length > 2), 10);
}

function scorePlatform(platform = {}, terms = [], product = {}) {
  const haystack = [
    product.name,
    product.description,
    product.audience,
    product.valueProposition,
    ...(product.keywords || [])
  ].join(" ").toLowerCase();
  const matches = (platform.fitKeywords || []).filter((keyword) => haystack.includes(String(keyword || "").toLowerCase()));
  const termBonus = Math.min(16, terms.length * 2);
  return Math.max(30, Math.min(95, 52 + matches.length * 9 + termBonus - (platform.risk === "high" ? 8 : 0)));
}

function platformName(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  const found = DEFAULT_PLATFORMS.find((entry) => entry.id === normalized || entry.name.toLowerCase() === normalized);
  return found?.name || normalized || "social";
}

function firstSentence(value = "", fallback = "") {
  const normalized = compactText(value, 500);
  if (!normalized) return fallback;
  const match = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return compactText(match ? match[1] : normalized, 180);
}

function buildPostBody({ product = {}, opportunity = {}, tone = "helpful", variant = 0, platform = "" } = {}) {
  const name = product.name || "this";
  const audience = product.audience || "people working on this problem";
  const value = product.valueProposition || firstSentence(product.description, "make the job easier");
  const angle = opportunity.angle || `A practical note for ${audience}`;
  const url = product.url ? `\n\n${product.url}` : "";
  const p = String(platform || opportunity.platform || "").trim().toLowerCase();
  const proof = product.description
    ? `\n\nThe problem it is trying to solve: ${compactText(product.description, 260)}`
    : "";
  const constraints = product.constraints ? `\n\nContext: ${compactText(product.constraints, 220)}` : "";
  const variantsByPlatform = {
    facebook: [
      `${name}\n\n${compactText(product.description || value, 320)}\n\n${compactText(value, 260)}${product.url ? `\n\nLearn more: ${product.url}` : ""}`,
      `A practical option for ${compactText(audience, 180)}.\n\n${name}: ${compactText(product.description || value, 320)}\n\n${compactText(value, 260)}${product.url ? `\n\nDetails: ${product.url}` : ""}`,
      `Need help with ${name.toLowerCase()}?\n\n${compactText(product.description || value, 320)}\n\n${compactText(value, 260)}${product.url ? `\n\nFind out more: ${product.url}` : ""}`
    ],
    reddit: [
      `I am looking for blunt feedback from people who actually deal with this.\n\n${name} is for ${audience}. It helps with: ${value}.${proof}${constraints}\n\nI do not want to do drive-by promo, so the useful question is: what would make this worth trying, and what would make you ignore it?${url}`,
      `Question for people here: how are you currently handling ${value}?\n\nI built ${name} for ${audience}, and I am trying to sanity-check whether the angle is actually useful for this community.${proof}\n\nHappy to share details, but mostly looking for what feels missing or overbuilt.${url}`,
      `${angle}\n\nI am building ${name}. The concrete use case is ${value}.${proof}\n\nIf this is relevant to your workflow, what would you need to see before trusting it?${url}`
    ],
    linkedin: [
      `${name} is built for ${audience}.\n\nThe practical problem: ${value}.${proof}\n\nI am looking for operators, founders, and teams who have run into this workflow and can pressure-test the positioning. The most useful feedback would be where this saves time, where it creates friction, and what proof would make it credible.${url}`,
      `A small product update:\n\n${name} helps ${audience} with ${value}.${proof}\n\nThe next step is not hype; it is better feedback from people close to the problem. If this maps to something your team deals with, I would value a sharp critique.${url}`,
      `Working on ${name}, focused on ${audience}.\n\nThe core promise is simple: ${value}.${proof}\n\nI am especially interested in what a professional buyer or daily user would need to know before taking it seriously.${url}`
    ],
    x: [
      `${name} is for ${audience}.\n\nIt helps with ${value}.\n\nLooking for sharp feedback from people who have this problem: what would make this immediately useful, and what would make you bounce?${url}`,
      `Building ${name}.\n\nAudience: ${audience}\nProblem: ${value}\n\nTrying to make the pitch clearer and the product more useful. What would you test first?${url}`,
      `If you deal with ${value}, I would like your read on ${name}.\n\nUseful? Too vague? Missing the real pain?\n\n${compactText(product.description, 180)}${url}`
    ],
    "hacker-news": [
      `I built ${name} for ${audience}. The aim is to help with ${value}.${proof}\n\nThe technical/product question I am trying to answer: is this solving a real workflow problem, or just packaging something people would rather script themselves?\n\nCritical feedback welcome.${url}`,
      `${name}: ${value}\n\nIt is aimed at ${audience}.${proof}\n\nI am interested in the failure modes: where would this be too brittle, too opaque, or not worth adopting?${url}`,
      `Show HN-style draft: ${name}\n\nIt helps ${audience} with ${value}.${proof}\n\nI would appreciate feedback on whether the problem framing is real and what technical detail should be shown up front.${url}`
    ],
    "product-hunt": [
      `${name} helps ${audience} ${value}.\n\nWhat it does:\n- ${compactText(value, 140)}\n- Built for ${compactText(audience, 140)}\n- Designed around practical workflow feedback${proof}\n\nI would love feedback on onboarding, positioning, and the first feature you would try.${url}`,
      `Launching an early version of ${name}.\n\nIt is for ${audience}, focused on ${value}.${proof}\n\nIf you try it, the question I care about most is: did it get you to value quickly enough?${url}`,
      `${name} is a practical tool for ${audience}.\n\nThe promise: ${value}.\n\nFeedback wanted on clarity, usefulness, and what should be added before a wider launch.${url}`
    ]
  };
  const generic = [
    `${angle}\n\n${name} is for ${audience}. It helps with ${value}.${proof}${constraints}\n\nI am looking for useful feedback from people close to the problem. What would make this worth trying?${url}`,
    `${name} is built around one problem: ${value}.\n\nAudience: ${audience}.${proof}\n\nI would rather get specific criticism than vague encouragement. What is unclear, unconvincing, or missing?${url}`,
    `Sharing ${name} because it may help ${audience}.\n\nThe useful bit: ${value}.${proof}\n\nIf this overlaps with your work, I would value a practical read on whether the promise is strong enough.${url}`
  ];
  const variants = variantsByPlatform[p] || variantsByPlatform[platformName(p).toLowerCase()] || generic;
  const picked = variants[Math.abs(Number(variant || 0)) % variants.length];
  if (String(tone || "").toLowerCase().includes("concise")) {
    return compactParagraphs(picked, 520);
  }
  return picked;
}

function buildReplyDraft({ product = {}, interaction = {} } = {}) {
  const text = String(interaction.text || "");
  const name = product.name || "it";
  const value = product.valueProposition || product.description || "the core workflow";
  if (interaction.intent === "pricing") {
    return `Thanks for asking. Pricing depends on the setup, but the best next step is to check the product page or tell me what you need it for and I can point you at the right option.`;
  }
  if (interaction.intent === "support") {
    return `Thanks for flagging that. Could you share what happened and where you hit the issue? I would like to understand it properly before guessing.`;
  }
  if (interaction.sentiment === "negative" || interaction.intent === "moderation-risk") {
    return `Fair point, and I do not want this to feel like drive-by promotion. The relevant reason I shared ${name} here is that it helps with ${value}. Happy to remove or clarify if this is not a fit for the thread.`;
  }
  if (interaction.sentiment === "question" || text.includes("?")) {
    return `Good question. ${name} is meant to help with ${value}. The shortest way to test whether it fits is to try it against one real workflow and see where it saves time.`;
  }
  return `Thanks, I appreciate you taking a look. The part I am most interested in improving is whether ${name} actually helps with ${value} in a real workflow.`;
}

function summarizeCampaign(state = {}) {
  const properties = state.properties.length;
  const products = state.products.length;
  const publishingTargets = state.publishingTargets.length;
  const opportunities = state.opportunities.length;
  const posts = state.posts.length;
  const drafts = state.posts.filter((post) => post.status === "draft").length;
  const approved = state.posts.filter((post) => post.status === "approved").length;
  const submitted = state.posts.filter((post) => post.status === "submitted").length;
  const published = state.posts.filter((post) => post.status === "published").length;
  const interactions = state.interactions.length;
  const needsReview = state.interactions.filter((entry) => entry.replyStatus === "needs-review").length;
  const totals = state.posts.reduce((acc, post) => {
    const metrics = normalizeMetrics(post.metrics || {});
    for (const key of Object.keys(metrics)) {
      acc[key] = Number(acc[key] || 0) + Number(metrics[key] || 0);
    }
    return acc;
  }, { views: 0, likes: 0, comments: 0, shares: 0, clicks: 0 });
  return { properties, products, publishingTargets, opportunities, posts, drafts, approved, submitted, published, interactions, needsReview, metrics: totals };
}

export function createSocialMediaManagerDomain({
  dataApi = null,
  broadcast = () => {}
} = {}) {
  const dataKey = "social-media-manager-state";

  async function readState() {
    const saved = dataApi ? await dataApi.readJson(dataKey, {}) : {};
    return normalizeState(saved);
  }

  async function writeState(state = {}) {
    const normalized = normalizeState(state);
    if (dataApi) {
      await dataApi.writeJson(dataKey, normalized);
    }
    return normalized;
  }

  async function listState(input = {}) {
    const state = await readState();
    const propertyRef = String(input.propertyId || input.property || "").trim();
    const property = propertyRef ? resolveProperty(state, propertyRef) : null;
    const scoped = scopeToProperty(state, property?.id || "");
    return {
      ...scoped,
      allProperties: state.properties.map((entry) => ({
        ...entry,
        summary: summarizeCampaign(scopeToProperty(state, entry.id))
      })),
      platforms: listPlatformCatalog(),
      summary: summarizeCampaign(scoped)
    };
  }

  async function saveProperty(input = {}) {
    const suppliedName = compactText(input.name || input.title || "", 160);
    const explicitId = compactText(input.id || input.propertyId || "", 120);
    const state = await readState();
    const existing = explicitId
      ? state.properties.find((entry) => entry.id === explicitId)
      : state.properties.find((entry) => entry.name.toLowerCase() === suppliedName.toLowerCase());
    if (explicitId && !existing) throw new Error(`Property "${explicitId}" not found.`);
    const name = suppliedName || existing?.name || "";
    if (!name || /^untitled(?: property)?$/i.test(name) || (existing?.id === DEFAULT_PROPERTY_ID && !suppliedName)) {
      throw new Error("A property needs a real name, such as the business, brand or site it promotes.");
    }
    const now = Date.now();
    const patch = { ...input, name };
    delete patch.propertyId;
    if (input.platforms !== undefined && input.channels === undefined) patch.channels = input.platforms;
    const property = existing
      ? normalizeProperty({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: now })
      : normalizeProperty({ ...patch, id: uniquePropertyKey(state, name), createdAt: now, updatedAt: now });
    const index = state.properties.findIndex((entry) => entry.id === property.id);
    if (index >= 0) state.properties[index] = property;
    else state.properties.push(property);
    await writeState(state);
    broadcast({ type: existing ? "social.property.updated" : "social.property.created", property });
    return property;
  }

  // Removing a property removes everything that belongs to it.
  async function removeProperty(propertyId = "") {
    const id = compactText(propertyId, 120);
    if (!id) throw new Error("property id is required");
    const state = await readState();
    const index = state.properties.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("property not found");
    const [removed] = state.properties.splice(index, 1);
    const counts = {};
    for (const kind of ["products", "opportunities", "posts", "interactions", "publishingTargets"]) {
      const before = state[kind].length;
      state[kind] = state[kind].filter((record) => record.propertyId !== id);
      counts[kind] = before - state[kind].length;
    }
    await writeState(state);
    broadcast({ type: "social.property.removed", property: removed, counts });
    return { property: removed, removed: counts };
  }

  async function saveProduct(input = {}) {
    const suppliedName = compactText(input.name || input.title || "", 160);
    const suppliedDetail = compactText(input.url || input.productUrl || input.description || input.valueProposition || input.value || "", 1200);
    if (!suppliedName || /^untitled(?: product)?$/i.test(suppliedName) || !suppliedDetail) {
      throw new Error("A real product or service name and supporting URL, description, or value proposition are required.");
    }
    const state = await readState();
    const now = Date.now();
    const explicitId = compactText(input.id || "", 140);
    const existingById = explicitId ? state.products.find((entry) => entry.id === explicitId) : null;
    const property = existingById && !input.propertyId && !input.property
      ? state.properties.find((entry) => entry.id === existingById.propertyId)
      : resolveProperty(state, input.propertyId || input.property, { create: true });
    const sameProduct = existingById || (!explicitId ? state.products.find((entry) =>
      entry.propertyId === property.id
      && entry.name.toLowerCase() === suppliedName.toLowerCase()
      && (!input.url || entry.url.toLowerCase() === String(input.url).trim().toLowerCase())
    ) : null);
    const index = sameProduct ? state.products.findIndex((entry) => entry.id === sameProduct.id) : -1;
    const saved = index >= 0
      ? normalizeProduct({ ...state.products[index], ...input, id: sameProduct.id, propertyId: property.id, verifiedAt: now, updatedAt: now })
      : normalizeProduct({
        ...input,
        id: explicitId || uniqueRecordId(state.products, `product-${property.id}-${slugify(suppliedName)}`),
        propertyId: property.id,
        sourceUrl: input.sourceUrl || input.url,
        evidence: input.evidence || input.description || input.valueProposition,
        verifiedAt: now,
        createdAt: now,
        updatedAt: now
      });
    if (index >= 0) state.products[index] = saved;
    else state.products.push(saved);
    await writeState(state);
    broadcast({ type: index >= 0 ? "social.product.updated" : "social.product.created", product: saved });
    return saved;
  }

  async function removeProduct(productId = "") {
    const id = compactText(productId, 140);
    if (!id) throw new Error("product id is required");
    const state = await readState();
    const index = state.products.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("product not found");
    const [removed] = state.products.splice(index, 1);
    await writeState(state);
    broadcast({ type: "social.product.removed", product: removed });
    return removed;
  }

  async function removeOpportunity(opportunityId = "") {
    const id = compactText(opportunityId, 140);
    if (!id) throw new Error("opportunity id is required");
    const state = await readState();
    const index = state.opportunities.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("opportunity not found");
    const [removed] = state.opportunities.splice(index, 1);
    await writeState(state);
    broadcast({ type: "social.opportunity.removed", opportunity: removed });
    return removed;
  }

  async function removePost(postId = "") {
    const id = compactText(postId, 140);
    if (!id) throw new Error("post id is required");
    const state = await readState();
    const index = state.posts.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("post not found");
    const [removed] = state.posts.splice(index, 1);
    state.interactions = state.interactions.filter((entry) => entry.postId !== id);
    await writeState(state);
    broadcast({ type: "social.post.removed", post: removed });
    return removed;
  }

  async function clearRecords(kind = "", propertyId = "") {
    const key = String(kind || "").trim();
    if (!["products", "publishingTargets", "opportunities", "posts"].includes(key)) throw new Error("unsupported record type");
    const state = await readState();
    const scope = String(propertyId || "").trim();
    const inScope = (record) => !scope || record.propertyId === scope;
    const removed = state[key].filter(inScope);
    state[key] = state[key].filter((record) => !inScope(record));
    await writeState(state);
    broadcast({ type: "social.records.cleared", kind: key, propertyId: scope, count: removed.length });
    return { kind: key, propertyId: scope, count: removed.length };
  }

  async function savePublishingTarget(input = {}) {
    const required = ["platform", "accountId", "label", "composerUrl", "bodySelector", "submitSelector"];
    const missing = required.filter((key) => !String(input[key] || "").trim());
    if (missing.length) throw new Error(`Publishing target is incomplete: ${missing.join(", ")} required.`);
    const state = await readState();
    const now = Date.now();
    const propertyRef = String(input.propertyId || input.property || "").trim();
    const propertyId = propertyRef ? resolveProperty(state, propertyRef).id : "";
    const target = normalizePublishingTarget({ ...input, propertyId, updatedAt: now });
    const index = state.publishingTargets.findIndex((entry) => entry.id === target.id);
    if (index >= 0) {
      state.publishingTargets[index] = normalizePublishingTarget({ ...state.publishingTargets[index], ...input, propertyId, id: target.id, updatedAt: now });
    } else {
      state.publishingTargets.push(target);
    }
    await writeState(state);
    const saved = index >= 0 ? state.publishingTargets[index] : target;
    broadcast({ type: index >= 0 ? "social.target.updated" : "social.target.created", publishingTarget: saved });
    return saved;
  }

  async function removePublishingTarget(targetId = "") {
    const id = compactText(targetId, 160);
    if (!id) throw new Error("publishing target id is required");
    const state = await readState();
    const index = state.publishingTargets.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("publishing target not found");
    const [removed] = state.publishingTargets.splice(index, 1);
    await writeState(state);
    broadcast({ type: "social.target.removed", publishingTarget: removed });
    return removed;
  }

  // A target named by id, or the active target for a platform and account.
  // A property's own target is preferred over one shared by all properties.
  async function findPublishingTarget(reference = {}) {
    const state = await readState();
    const targetId = String(reference.targetId || reference.id || "").trim();
    if (targetId) return state.publishingTargets.find((target) => target.id === targetId) || null;
    const platform = platformId(reference.platform || reference.service || "");
    const accountId = String(reference.accountId || "").trim().toLowerCase();
    const propertyId = String(reference.propertyId || "").trim();
    if (!platform) return null;
    const matches = state.publishingTargets.filter((target) =>
      target.platform === platform
      && (accountId ? target.accountId === accountId : target.status === "active")
      && (!target.propertyId || !propertyId || target.propertyId === propertyId)
    );
    return matches.find((target) => propertyId && target.propertyId === propertyId) || matches[0] || null;
  }

  async function findProduct(reference = "") {
    const state = await readState();
    const normalized = String(reference || "").trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return state.products.find((product) =>
      product.id.toLowerCase() === normalized
      || product.name.toLowerCase() === normalized
      || product.name.toLowerCase().includes(normalized)
    ) || null;
  }

  function productFor(state, input = {}) {
    const productId = String(input.productId || "").trim();
    const reference = String(input.product || input.name || "").trim().toLowerCase();
    const propertyRef = String(input.propertyId || input.property || "").trim();
    const property = propertyRef ? resolveProperty(state, propertyRef) : null;
    const candidates = property ? state.products.filter((entry) => entry.propertyId === property.id) : state.products;
    return (productId ? candidates.find((entry) => entry.id === productId) : null)
      || (productId ? candidates.find((entry) => entry.name.toLowerCase() === productId.toLowerCase()) : null)
      || (reference ? candidates.find((entry) => entry.name.toLowerCase() === reference) : null)
      || (reference ? candidates.find((entry) => entry.name.toLowerCase().includes(reference)) : null)
      || null;
  }

  async function discoverOpportunities(input = {}) {
    const state = await readState();
    const product = productFor(state, input);
    if (!product) throw new Error("Choose a saved, verified product or service before discovering opportunities.");
    const candidateUrls = uniqueStrings(input.candidateUrls || input.urls || [], 20);
    if (!candidateUrls.length) {
      throw new Error("No researched candidate URLs were supplied. Inspect real communities or pages first; generic search links are not saved as opportunities.");
    }
    const generated = [];
    for (const url of candidateUrls) {
      generated.push(normalizeOpportunity({
        id: `opp-${product.id}-candidate-${slugify(url)}`,
        propertyId: product.propertyId,
        productId: product.id,
        platform: "web",
        platformName: "Web candidate",
        title: `Candidate community: ${url}`,
        url,
        searchQuery: product.name,
        score: 50,
        risk: "medium",
        audienceFit: `Research candidate for ${product.audience || product.name}; keep only after confirming its rules, audience, and recent activity.`,
        postingGuidance: "Inspect recent posts and rules before publishing. Prefer a helpful answer or case study over a direct ad.",
        angle: `Use a concrete example from ${product.name}.`
      }));
    }
    for (const opportunity of generated) {
      const index = state.opportunities.findIndex((entry) => entry.id === opportunity.id);
      if (index >= 0) {
        state.opportunities[index] = { ...state.opportunities[index], ...opportunity, updatedAt: Date.now() };
      } else {
        state.opportunities.push(opportunity);
      }
    }
    await writeState(state);
    broadcast({ type: "social.opportunities.discovered", product, opportunities: generated });
    return { product, opportunities: generated.sort((left, right) => right.score - left.score) };
  }

  // The platform a draft is for: the one asked for, the opportunity's, or the
  // property's first channel. A property with channels only posts to them.
  function draftPlatform(property, requested = "", opportunity = null) {
    const channels = enabledChannels(property);
    const allowed = channels.map((channel) => channel.platform);
    const asked = platformId(requested);
    if (asked) {
      if (allowed.length && !allowed.includes(asked)) {
        throw new Error(`${platformName(asked)} is not one of ${property.name}'s channels: ${channels.map((channel) => channel.label).join(", ")}.`);
      }
      return asked;
    }
    const fromOpportunity = opportunity?.platform && opportunity.platform !== "web" ? opportunity.platform : "";
    if (fromOpportunity && (!allowed.length || allowed.includes(fromOpportunity))) return fromOpportunity;
    return allowed[0] || fromOpportunity || "";
  }

  async function composePosts(input = {}) {
    const state = await readState();
    const product = productFor(state, input);
    if (!product) {
      throw new Error("product is required before composing posts");
    }
    const property = state.properties.find((entry) => entry.id === product.propertyId) || {};
    const opportunity = state.opportunities.find((entry) =>
      entry.id === String(input.opportunityId || "").trim()
    ) || state.opportunities.find((entry) => entry.productId === product.id);
    const platform = draftPlatform(property, input.platform, opportunity);
    const count = Math.max(1, Math.min(5, Number(input.count || 3) || 3));
    const created = [];
    for (let index = 0; index < count; index += 1) {
      const post = normalizePost({
        propertyId: product.propertyId,
        productId: product.id,
        opportunityId: opportunity?.id || "",
        platform,
        title: compactText(input.title || `${product.name} post for ${platform ? platformName(platform) : opportunity?.platformName || "social"}`, 220),
        body: buildPostBody({
          product: { ...product, url: product.url || property.website || "" },
          opportunity,
          tone: input.tone || property.voice,
          variant: index,
          platform
        }),
        callToAction: input.callToAction || "Ask for feedback from people who have the problem.",
        status: "draft"
      });
      state.posts.push(post);
      created.push(post);
    }
    await writeState(state);
    broadcast({ type: "social.posts.composed", posts: created });
    return created;
  }

  async function recordMonitorSnapshot(input = {}) {
    const state = await readState();
    const postId = String(input.postId || "").trim();
    const post = state.posts.find((entry) => entry.id === postId) || null;
    if (!post) {
      throw new Error("post not found");
    }
    const seen = new Set(state.interactions.map((entry) => `${entry.postId}:${entry.author}:${entry.text}`.toLowerCase()));
    const recorded = [];
    for (const comment of Array.isArray(input.comments) ? input.comments : []) {
      const normalized = normalizeInteraction({
        ...comment,
        propertyId: post.propertyId,
        postId: post.id,
        productId: post.productId,
        platform: post.platform,
        externalUrl: comment.externalUrl || post.publishedUrl
      });
      const key = `${normalized.postId}:${normalized.author}:${normalized.text}`.toLowerCase();
      if (!normalized.text || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const product = state.products.find((entry) => entry.id === post.productId) || null;
      if (!normalized.replyDraft) {
        normalized.replyDraft = buildReplyDraft({ product, interaction: normalized });
      }
      state.interactions.push(normalized);
      recorded.push(normalized);
    }
    if (input.metrics && typeof input.metrics === "object") {
      const index = state.posts.findIndex((entry) => entry.id === post.id);
      state.posts[index] = normalizePost({
        ...post,
        metrics: {
          ...(post.metrics || {}),
          ...input.metrics
        },
        updatedAt: Date.now()
      });
    }
    await writeState(state);
    broadcast({ type: "social.post.monitored", postId: post.id, recordedCount: recorded.length });
    return { postId: post.id, recorded, recordedCount: recorded.length };
  }

  async function updatePost(postId = "", patch = {}) {
    const state = await readState();
    const id = String(postId || patch.id || "").trim();
    const index = state.posts.findIndex((entry) => entry.id === id);
    if (index < 0) {
      throw new Error("post not found");
    }
    // A post stays with the product and property it was drafted for.
    const { propertyId: _propertyId, productId: _productId, ...editable } = patch;
    state.posts[index] = normalizePost({ ...state.posts[index], ...editable, id, updatedAt: Date.now() });
    await writeState(state);
    broadcast({ type: "social.post.updated", post: state.posts[index] });
    return state.posts[index];
  }

  async function recordInteraction(input = {}) {
    const state = await readState();
    const post = state.posts.find((entry) => entry.id === String(input.postId || "").trim()) || null;
    const product = state.products.find((entry) => entry.id === (input.productId || post?.productId)) || null;
    const interaction = normalizeInteraction({
      ...input,
      propertyId: post?.propertyId || product?.propertyId || input.propertyId || "",
      productId: input.productId || post?.productId || "",
      platform: input.platform || post?.platform || ""
    });
    if (!interaction.replyDraft) {
      interaction.replyDraft = buildReplyDraft({ product, interaction });
    }
    const index = state.interactions.findIndex((entry) => entry.id === interaction.id);
    if (index >= 0) {
      state.interactions[index] = interaction;
    } else {
      state.interactions.push(interaction);
    }
    await writeState(state);
    broadcast({ type: "social.interaction.recorded", interaction });
    return interaction;
  }

  async function updateInteraction(interactionId = "", patch = {}) {
    const state = await readState();
    const id = String(interactionId || patch.id || "").trim();
    const index = state.interactions.findIndex((entry) => entry.id === id);
    if (index < 0) {
      throw new Error("interaction not found");
    }
    state.interactions[index] = normalizeInteraction({ ...state.interactions[index], ...patch, id, updatedAt: Date.now() });
    await writeState(state);
    broadcast({ type: "social.interaction.updated", interaction: state.interactions[index] });
    return state.interactions[index];
  }

  async function buildReport(input = {}) {
    const state = await readState();
    const propertyRef = String(input.propertyId || input.property || "").trim();
    const property = propertyRef ? resolveProperty(state, propertyRef) : null;
    const scoped = scopeToProperty(state, property?.id || "");
    const productRef = String(input.productId || input.product || "").trim().toLowerCase();
    const platform = platformId(input.platform || "");
    const products = productRef
      ? scoped.products.filter((product) => product.id.toLowerCase() === productRef || product.name.toLowerCase().includes(productRef))
      : scoped.products;
    const productIds = new Set(products.map((product) => product.id));
    const matches = (entry) => (!productRef || productIds.has(entry.productId)) && (!platform || entry.platform === platform);
    const opportunities = scoped.opportunities.filter(matches);
    const posts = scoped.posts.filter(matches);
    const interactions = scoped.interactions.filter(matches);
    const summary = summarizeCampaign({ ...scoped, products, opportunities, posts, interactions });
    const topOpportunities = opportunities.slice().sort((left, right) => right.score - left.score).slice(0, 8);
    const pendingReplies = interactions.filter((entry) => entry.replyStatus === "needs-review").slice(0, 8);
    const propertyName = (id) => state.properties.find((entry) => entry.id === id)?.name || id;
    const tag = (id) => property ? "" : ` [${propertyName(id)}]`;
    const lines = [
      property ? `Social media manager report: ${property.name}` : `Social media manager report: all ${state.properties.length} properties`,
      `Products: ${summary.products}; publishing targets: ${summary.publishingTargets}; opportunities: ${summary.opportunities}; posts: ${summary.posts} (${summary.drafts} draft, ${summary.approved} approved, ${summary.submitted} awaiting verification, ${summary.published} published).`,
      `Interactions: ${summary.interactions}; replies needing review: ${summary.needsReview}.`,
      `Metrics: ${summary.metrics.views} views, ${summary.metrics.likes} likes, ${summary.metrics.comments} comments, ${summary.metrics.shares} shares, ${summary.metrics.clicks} clicks.`
    ];
    if (!property && state.properties.length > 1) {
      lines.push("By property:");
      for (const entry of state.properties) {
        const each = summarizeCampaign(scopeToProperty(state, entry.id));
        lines.push(`- ${entry.name}: ${each.products} products, ${each.posts} posts, ${each.published} published, ${each.needsReview} replies needing review`);
      }
    }
    if (topOpportunities.length) {
      lines.push("Top opportunities:");
      for (const opportunity of topOpportunities) {
        lines.push(`- ${opportunity.platformName}: ${opportunity.title} (${opportunity.score}/100)${tag(opportunity.propertyId)}`);
      }
    }
    if (pendingReplies.length) {
      lines.push("Replies needing review:");
      for (const interaction of pendingReplies) {
        lines.push(`- ${interaction.author || "Unknown"}: ${compactText(interaction.text, 90)}${tag(interaction.propertyId)}`);
      }
    }
    return { text: lines.join("\n"), summary, property, products, opportunities, posts, interactions };
  }

  return {
    buildReport,
    clearRecords,
    composePosts,
    discoverOpportunities,
    findPublishingTarget,
    findProduct,
    listState,
    recordMonitorSnapshot,
    readState,
    recordInteraction,
    removeOpportunity,
    removePost,
    removeProduct,
    removeProperty,
    removePublishingTarget,
    savePublishingTarget,
    saveProduct,
    saveProperty,
    updateInteraction,
    updatePost,
    writeState
  };
}
