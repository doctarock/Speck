import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSocialMediaManagerDomain } from "./lib/social-media-manager-domain.js";

const PLUGIN_ID = "social-media-manager";
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const UI_SCRIPT_URL = `/plugins/${PLUGIN_ID}/ui.js`;
const UI_SCRIPT_PATH = fileURLToPath(new URL("./ui/social-media-manager-ui.js", import.meta.url));

const property = { propertyId: "string" };
const tools = [
  { name: "social_save_property", description: "Save or update a property: a business, brand or site with its own products, channels, voice and guidelines. Pass id to update one.", parameters: { id: "string", name: "string", website: "string", description: "string", audience: "string", voice: "string", platforms: "array|string", keywords: "array|string", guidelines: "string", status: "active|paused|archived" } },
  { name: "social_list_properties", description: "List the properties, their channels, and each property's campaign totals.", parameters: {} },
  { name: "social_save_product", description: "Save a real product or service of a property with supporting details.", parameters: { ...property, name: "string", url: "string", description: "string", audience: "string", valueProposition: "string", sourceUrl: "string", evidence: "string" } },
  { name: "social_find_posting_opportunities", description: "Record researched social posting opportunities for a product.", risk: "medium", parameters: { ...property, productId: "string", platforms: "array|string", candidateUrls: "array|string", keywords: "array|string" } },
  { name: "social_compose_posts", description: "Draft posts for a saved product on one of its property's channels.", parameters: { ...property, productId: "string", opportunityId: "string", platform: "string", tone: "string", count: "number", callToAction: "string" } },
  { name: "social_list_campaign", description: "List a property's products, drafts, publishing targets, interactions and totals, or every property's when none is named.", parameters: { ...property } },
  { name: "social_get_report", description: "Summarise a property's social campaign, or all properties, and the posts needing attention.", parameters: { ...property, productId: "string", platform: "string" } },
  { name: "social_update_post", description: "Edit, approve, or verify a post and update its schedule and metrics.", parameters: { postId: "string", status: "draft|approved|submitted|published|archived", publishedUrl: "string", title: "string", body: "string", scheduledAt: "string", metrics: "object" } },
  { name: "social_save_publishing_target", description: "Save a browser publishing target and its composer selectors. Pass propertyId to use it only for that property.", parameters: { ...property, id: "string", platform: "string", accountId: "string", label: "string", composerUrl: "string", bodySelector: "string", submitSelector: "string", titleSelector: "string" } },
  { name: "social_publish_post", description: "Publish an approved post through its property's browser target or platform webhook.", risk: "high", parameters: { postId: "string", targetId: "string" } },
  { name: "social_record_interaction", description: "Record a comment and prepare a suggested reply for review.", parameters: { postId: "string", author: "string", text: "string", externalUrl: "string", sentiment: "string" } },
  { name: "social_update_interaction", description: "Update a tracked comment or reply status.", parameters: { interactionId: "string", replyDraft: "string", replyStatus: "string" } }
];
const READ_ONLY_TOOLS = ["social_list_properties", "social_list_campaign", "social_get_report"];

export default function createSocialMediaManagerPlugin() {
  let domain = null;
  const domainFor = (api) => {
    domain ||= createSocialMediaManagerDomain({ dataApi: api.data, broadcast: (event) => api.broadcast?.(event) });
    return domain;
  };
  return {
    id: PLUGIN_ID,
    name: "Social Media Manager",
    version: "3.0.0",
    description: "Social campaigns for several properties: products, channels, drafts, publishing, interactions and reports.",
    manifest: {
      schemaVersion: 1,
      permissions: {
        routes: true, uiPanels: true, data: true,
        tools: tools.map((tool) => tool.name), capabilities: [], hooks: [], runtimeContext: []
      },
      dependencies: { requiredCapabilities: [], optionalCapabilities: ["browser.externalAction", "speck:secret-get", "speck:secret-has", "speck:secret-set", "speck:secret-delete"] },
      security: { isolation: "inprocess" },
      // What this plugin is about (Genesis core API 1.5.0): read by the host to
      // decide when to offer its tools.
      topics: {
        "keywords": [
          "social media",
          "marketing campaign",
          "promoting products",
          "product launch",
          "brands and properties",
          "LinkedIn",
          "Reddit",
          "Hacker News",
          "Product Hunt",
          "Indie Hackers",
          "X",
          "TikTok",
          "Facebook",
          "Instagram",
          "post drafts",
          "approving and publishing posts",
          "comments and replies",
          "engagement report"
        ],
        "examples": [
          "Write a launch post for our new product",
          "Where should we promote the store online?",
          "Approve and publish the drafted post",
          "Suggest a reply to a comment on our post",
          "How are our posts performing?",
          "Add our new product to the campaign",
          "Add another business to the social media manager"
        ]
      }
    },
    init(api) {
      const domain = domainFor(api);
      const actions = {
        social_save_property: (args) => domain.saveProperty(args),
        social_list_properties: async () => {
          const state = await domain.listState();
          return { properties: state.allProperties, platforms: state.platforms };
        },
        social_save_product: (args) => domain.saveProduct(args),
        social_find_posting_opportunities: (args) => domain.discoverOpportunities(args),
        social_compose_posts: (args) => domain.composePosts(args),
        social_list_campaign: (args) => domain.listState(args),
        social_get_report: (args) => domain.buildReport(args),
        social_update_post: (args) => updatePost(domain, args.postId, args),
        social_save_publishing_target: (args) => domain.savePublishingTarget(args),
        social_record_interaction: (args) => domain.recordInteraction(args),
        social_update_interaction: (args) => domain.updateInteraction(args.interactionId, args),
        social_publish_post: (args) => publish(api, domain, args)
      };
      for (const tool of tools) api.registerTool({ ...tool, risk: tool.risk || (READ_ONLY_TOOLS.includes(tool.name) ? "read-only" : "normal"), scopes: ["worker"] }, actions[tool.name]);
      api.registerUiPrimaryTab?.({ id: "social", title: "Social", order: 50, scriptUrl: UI_SCRIPT_URL });
    },
    registerRoutes({ app, api }) {
      const domain = domainFor(api);
      registerUiRoutes(app, api, domain);
    }
  };
}

function updatePost(domain, postId, patch = {}) {
  if (patch.status === "published" && !patch.publishedUrl) throw new Error("publishedUrl is required to verify a post");
  return domain.updatePost(postId, patch);
}

// The secrets a property's channel publishes with: its own, or the platform's
// shared webhook when the property has none.
function webhookHandles(propertyId = "", platform = "") {
  const own = propertyId ? [`social.${propertyId}.${platform}`] : [];
  return [...own, `social.${platform}`].map((prefix) => ({ url: `${prefix}.webhook-url`, token: `${prefix}.webhook-token` }));
}

async function publish(api, domain, args) {
  const state = await domain.readState();
  const post = state.posts.find((entry) => entry.id === String(args.postId || ""));
  if (!post) throw new Error("post not found");
  if (post.status !== "approved") throw new Error("approve the draft before publishing");
  const target = args.targetId
    ? await domain.findPublishingTarget({ targetId: args.targetId })
    : await domain.findPublishingTarget({ platform: post.platform, propertyId: post.propertyId });
  if (args.targetId && !target) throw new Error("publishing target not found");
  let receipt;
  const browserSubmission = Boolean(target);
  if (target) {
    const browserAction = api.getCapability("browser.externalAction");
    if (typeof browserAction !== "function") throw new Error("browser publishing capability is unavailable");
    const base = { service: target.platform, accountId: target.accountId, requiresApproval: false };
    await browserAction({ ...base, action: "navigate", url: target.composerUrl });
    if (target.titleSelector && post.title) await browserAction({ ...base, action: "fill", selector: target.titleSelector, value: post.title });
    await browserAction({ ...base, action: "fill", selector: target.bodySelector, value: post.body });
    receipt = await browserAction({ ...base, action: "click", selector: target.submitSelector });
    if (receipt?.ok === false || receipt?.success === false) throw new Error("browser publishing failed");
  } else {
    const getSecret = api.getCapability("speck:secret-get");
    if (typeof getSecret !== "function") throw new Error("secret store is unavailable");
    const platform = String(post.platform || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    let endpoint = "";
    let handles = null;
    for (const candidate of webhookHandles(post.propertyId, platform)) {
      endpoint = await getSecret({ handle: candidate.url }).catch(() => "");
      if (endpoint) { handles = candidate; break; }
    }
    if (!endpoint) throw new Error(`configure secret social.${post.propertyId}.${platform}.webhook-url (or social.${platform}.webhook-url) or a browser publishing target`);
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("social webhook must be an HTTPS URL without embedded credentials");
    const token = await getSecret({ handle: handles.token }).catch(() => "");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ postId: post.id, propertyId: post.propertyId, platform, title: post.title, body: post.body, productId: post.productId }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`social webhook returned HTTP ${response.status}`);
    receipt = await response.json().catch(() => ({}));
    if (receipt?.ok === false || receipt?.success === false) throw new Error(String(receipt.error || "social webhook rejected the post"));
  }
  const publishedUrl = String(receipt?.url || receipt?.publishedUrl || "");
  if (browserSubmission ? receipt?.verified !== true : !receipt?.verified && !publishedUrl) {
    const submitted = await domain.updatePost(post.id, { status: "submitted" });
    return { post: submitted, submitted: true, verificationRequired: true, receipt };
  }
  const updated = await domain.updatePost(post.id, { status: "published", publishedAt: Date.now(), publishedUrl });
  return { post: updated, publishedUrl, receipt };
}

// Which webhook secrets each of a property's channels has. Values never leave
// the secret store; the UI only learns whether a handle is set.
async function channelSecrets(api, domain, propertyId) {
  const has = api.getCapability("speck:secret-has");
  const state = await domain.listState({ propertyId });
  const property = state.properties[0];
  const channels = [];
  for (const channel of property.channels) {
    const [own, shared] = webhookHandles(property.id, channel.platform);
    const check = async (handle) => typeof has === "function" ? Boolean(await has({ handle })) : false;
    channels.push({
      platform: channel.platform,
      handles: own,
      sharedHandles: shared,
      webhookUrl: await check(own.url),
      webhookToken: await check(own.token),
      sharedWebhookUrl: await check(shared.url)
    });
  }
  return { propertyId: property.id, channels, available: typeof has === "function" };
}

async function setChannelSecret(api, domain, propertyId, body = {}) {
  const state = await domain.listState({ propertyId });
  const property = state.properties[0];
  const platform = String(body.platform || "");
  if (!property.channels.some((channel) => channel.platform === platform)) throw new Error(`${platform || "That platform"} is not one of ${property.name}'s channels`);
  const kind = body.kind === "token" ? "token" : "url";
  const [own] = webhookHandles(property.id, platform);
  const handle = own[kind];
  const value = String(body.value ?? "").trim();
  if (!value) {
    const remove = api.getCapability("speck:secret-delete");
    if (typeof remove !== "function") throw new Error("secret store is unavailable");
    await remove({ handle });
    return { handle, set: false };
  }
  if (kind === "url") {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("social webhook must be an HTTPS URL without embedded credentials");
  }
  const set = api.getCapability("speck:secret-set");
  if (typeof set !== "function") throw new Error("secret store is unavailable");
  await set({ handle, value });
  return { handle, set: true };
}

function registerUiRoutes(app, api, domain) {
  const route = (handler) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await handler(req)) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  // The tab script holds no data; the data routes below need the admin token.
  app.get(UI_SCRIPT_URL, async (_req, res) => {
    try {
      res.type("text/javascript").set("cache-control", "no-cache").send(await fs.readFile(UI_SCRIPT_PATH, "utf8"));
    } catch {
      res.status(404).type("text/plain").send("Social Media Manager interface is unavailable");
    }
  });

  app.get(`${API_BASE}/state`, route(async (req) => ({ state: await domain.listState({ propertyId: req.query.propertyId }) })));
  app.get(`${API_BASE}/report`, route(async (req) => ({ report: await domain.buildReport({ propertyId: req.query.propertyId }) })));

  app.post(`${API_BASE}/properties`, route(async (req) => ({ property: await domain.saveProperty(body(req)) })));
  app.delete(`${API_BASE}/properties/:id`, route(async (req) => domain.removeProperty(req.params.id)));
  app.get(`${API_BASE}/properties/:id/secrets`, route(async (req) => ({ secrets: await channelSecrets(api, domain, req.params.id) })));
  app.post(`${API_BASE}/properties/:id/secrets`, route(async (req) => ({ secret: await setChannelSecret(api, domain, req.params.id, body(req)) })));

  app.post(`${API_BASE}/products`, route(async (req) => ({ product: await domain.saveProduct(body(req)) })));
  app.delete(`${API_BASE}/products/:id`, route(async (req) => ({ product: await domain.removeProduct(req.params.id) })));

  app.post(`${API_BASE}/opportunities`, route(async (req) => domain.discoverOpportunities(body(req))));
  app.delete(`${API_BASE}/opportunities/:id`, route(async (req) => ({ opportunity: await domain.removeOpportunity(req.params.id) })));

  app.post(`${API_BASE}/posts/compose`, route(async (req) => ({ posts: await domain.composePosts(body(req)) })));
  app.patch(`${API_BASE}/posts/:id`, route(async (req) => ({ post: await updatePost(domain, req.params.id, body(req)) })));
  app.delete(`${API_BASE}/posts/:id`, route(async (req) => ({ post: await domain.removePost(req.params.id) })));
  // A person pressing Publish in the tab is the approval the tool path asks for.
  app.post(`${API_BASE}/posts/:id/publish`, route(async (req) => publish(api, domain, { postId: req.params.id, targetId: body(req).targetId })));

  app.post(`${API_BASE}/targets`, route(async (req) => ({ publishingTarget: await domain.savePublishingTarget(body(req)) })));
  app.delete(`${API_BASE}/targets/:id`, route(async (req) => ({ publishingTarget: await domain.removePublishingTarget(req.params.id) })));

  app.post(`${API_BASE}/interactions`, route(async (req) => ({ interaction: await domain.recordInteraction(body(req)) })));
  app.patch(`${API_BASE}/interactions/:id`, route(async (req) => ({ interaction: await domain.updateInteraction(req.params.id, body(req)) })));
}
