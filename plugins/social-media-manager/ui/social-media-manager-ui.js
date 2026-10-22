// The Social Media Manager tab: properties, each with its own products,
// channels, posts and replies. Served by the plugin; mounted by Speck.

const API = "/api/plugins/social-media-manager";
const SECTIONS = [
  ["overview", "Overview"],
  ["products", "Products"],
  ["channels", "Channels"],
  ["posts", "Posts"],
  ["replies", "Replies"],
  ["settings", "Settings"]
];
const POST_FILTERS = ["all", "draft", "approved", "submitted", "published", "archived"];
const REPLY_STATUSES = ["needs-review", "approved", "replied", "ignored"];

const escapeHtml = (value = "") => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[character]);
const when = (value) => {
  const date = new Date(Number(value || 0));
  return Number(value) > 0 && Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
};
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export async function mountPluginTab({ root, pluginAdminFetch, observerApp }) {
  const fetcher = pluginAdminFetch || observerApp?.adminFetch || fetch;
  const ui = createSocialManagerUi(root, fetcher);
  await ui.load();
  return ui;
}

function createSocialManagerUi(root, fetcher) {
  const view = {
    state: null,
    propertyId: readPreference("property"),
    section: readPreference("section") || "overview",
    postFilter: "all",
    editing: null, // { kind, id } of the record whose form is open
    secrets: null,
    busy: false,
    error: ""
  };
  injectStyles();
  root.classList.add("smm");
  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("change", onChange);

  async function request(path, { method = "GET", body } = {}) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetcher(`${API}${path}`, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
    return payload;
  }

  async function load() {
    try {
      const { state } = await request("/state");
      view.state = state;
      const ids = state.allProperties.map((property) => property.id);
      if (!ids.includes(view.propertyId)) view.propertyId = ids[0] || "";
      view.error = "";
      if (view.section === "channels" && view.propertyId) await loadSecrets();
    } catch (error) {
      view.error = error.message;
    }
    render();
  }

  async function loadSecrets() {
    try {
      view.secrets = (await request(`/properties/${encodeURIComponent(view.propertyId)}/secrets`)).secrets;
    } catch {
      view.secrets = null;
    }
  }

  // Runs one change, reloads, and reports the outcome.
  async function act(work, done = "") {
    if (view.busy) return;
    view.busy = true;
    root.classList.add("smm-busy");
    try {
      const result = await work();
      await load();
      if (done) notice(typeof done === "function" ? done(result) : done);
    } catch (error) {
      notice(error.message, true);
    } finally {
      view.busy = false;
      root.classList.remove("smm-busy");
    }
  }

  function notice(message, isError = false) {
    const toast = document.querySelector("#toast");
    if (toast) {
      toast.textContent = message;
      toast.classList.toggle("error", isError);
      toast.classList.add("show");
      clearTimeout(notice.timer);
      notice.timer = setTimeout(() => toast.classList.remove("show"), 3200);
    } else if (isError) {
      alert(message);
    }
  }

  const creatingProperty = () => view.editing?.kind === "property" && !view.editing.id;
  const property = () => view.state?.allProperties.find((entry) => entry.id === view.propertyId) || null;
  const scoped = (kind) => (view.state?.[kind] || []).filter((record) => record.propertyId === view.propertyId);
  const platformLabel = (id) => view.state?.platforms.find((entry) => entry.id === id)?.name || id || "Any";
  const productName = (id) => view.state?.products.find((entry) => entry.id === id)?.name || "Unknown product";

  function render() {
    if (!view.state) {
      root.innerHTML = view.error
        ? `<div class="smm-empty">The Social Media Manager could not load.<br>${escapeHtml(view.error)}<br><br><button class="smm-button" data-action="reload">Try again</button></div>`
        : `<div class="smm-empty">Loading properties…</div>`;
      return;
    }
    const current = property();
    root.innerHTML = `<div class="smm-layout">
      <aside class="smm-sidebar" aria-label="Properties">
        <div class="smm-sidebar-head"><span class="smm-eyebrow">Properties</span>
          <button class="smm-button smm-small" data-action="new-property">+ New</button></div>
        <div class="smm-property-list">${view.state.allProperties.map(propertyCard).join("") || `<p class="smm-muted">No properties yet.</p>`}</div>
      </aside>
      <section class="smm-main">${creatingProperty()
        ? newPropertyView()
        : current ? propertyView(current) : welcomeView()}</section>
    </div>`;
  }

  function propertyCard(entry) {
    const summary = entry.summary || {};
    const attention = summary.needsReview + summary.approved;
    return `<button class="smm-property ${entry.id === view.propertyId && !creatingProperty() ? "active" : ""}" data-action="select-property" data-id="${escapeHtml(entry.id)}">
      <span class="smm-property-name">${escapeHtml(entry.name)}${entry.status !== "active" ? ` <em>${escapeHtml(entry.status)}</em>` : ""}</span>
      <span class="smm-chips">${entry.channels.filter((channel) => channel.enabled).map((channel) => `<i>${escapeHtml(channel.label)}</i>`).join("") || `<i class="smm-chip-empty">no channels</i>`}</span>
      <span class="smm-property-meta">${plural(summary.products || 0, "product")} · ${plural(summary.posts || 0, "post")}${attention ? ` · <b>${attention} waiting</b>` : ""}</span>
    </button>`;
  }

  function welcomeView() {
    return `<div class="smm-empty"><h3>Add your first property</h3>
      <p>A property is a business, brand or site you promote. Each one keeps its own products, channels, voice and posts.</p>
      <button class="smm-button smm-primary" data-action="new-property">Create a property</button></div>`;
  }

  function newPropertyView() {
    return `<header class="smm-head"><div><span class="smm-eyebrow">New property</span><h2>Create a property</h2>
      <p class="smm-muted">Name the business, brand or site. Products and channels are added after it is saved.</p></div></header>
      ${propertyForm({ channels: [] })}`;
  }

  function propertyView(current) {
    const summary = current.summary || {};
    return `<header class="smm-head">
        <div><span class="smm-eyebrow">Property</span><h2>${escapeHtml(current.name)}</h2>
          <p class="smm-muted">${current.website ? `<a href="${escapeHtml(current.website)}" target="_blank" rel="noopener">${escapeHtml(current.website)}</a> · ` : ""}${plural(summary.products || 0, "product")} · ${plural(current.channels.filter((channel) => channel.enabled).length, "channel")} · ${summary.published || 0} published</p></div>
        <button class="smm-button" data-action="reload" title="Reload">↻</button>
      </header>
      <nav class="smm-tabs" role="tablist">${SECTIONS.map(([id, label]) => {
        const count = id === "posts" ? summary.drafts + summary.approved : id === "replies" ? summary.needsReview : 0;
        return `<button role="tab" aria-selected="${view.section === id}" class="smm-tab ${view.section === id ? "active" : ""}" data-action="section" data-id="${id}">${label}${count ? `<span>${count}</span>` : ""}</button>`;
      }).join("")}</nav>
      <div class="smm-section">${sectionView(current)}</div>`;
  }

  function sectionView(current) {
    switch (view.section) {
      case "products": return productsView(current);
      case "channels": return channelsView(current);
      case "posts": return postsView(current);
      case "replies": return repliesView();
      case "settings": return settingsView(current);
      default: return overviewView(current);
    }
  }

  // ---- Overview -------------------------------------------------------

  function overviewView(current) {
    const summary = current.summary;
    const metrics = summary.metrics || {};
    const cards = [
      ["Drafts", summary.drafts, "waiting for approval"],
      ["Approved", summary.approved, "ready to publish"],
      ["Awaiting verification", summary.submitted, "submitted, not yet confirmed"],
      ["Published", summary.published, `${metrics.views || 0} views · ${metrics.clicks || 0} clicks`],
      ["Replies to review", summary.needsReview, plural(summary.interactions, "interaction")]
    ];
    const posts = scoped("posts").filter((post) => ["draft", "approved", "submitted"].includes(post.status))
      .sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 6);
    const missing = [];
    if (!current.channels.some((channel) => channel.enabled)) missing.push(["channels", "Choose the channels this property posts to."]);
    if (!scoped("products").length) missing.push(["products", "Add a product or service to promote."]);
    return `${missing.length ? `<div class="smm-callout">${missing.map(([section, text]) => `<p>${escapeHtml(text)} <button class="smm-link" data-action="section" data-id="${section}">Open ${section}</button></p>`).join("")}</div>` : ""}
      <div class="smm-metrics">${cards.map(([label, value, detail]) => `<article class="smm-metric"><span class="smm-eyebrow">${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong><small>${escapeHtml(detail)}</small></article>`).join("")}</div>
      <h3 class="smm-subhead">Needs attention</h3>
      ${posts.map((post) => postCard(post, { compact: true })).join("") || `<p class="smm-muted">Nothing is waiting. Draft posts from the Products section.</p>`}`;
  }

  // ---- Products -------------------------------------------------------

  function productsView(current) {
    const products = scoped("products");
    const editing = view.editing?.kind === "product" ? view.editing : null;
    const channels = current.channels.filter((channel) => channel.enabled);
    return `<div class="smm-section-head"><p class="smm-muted">Products and services promoted under ${escapeHtml(current.name)}.</p>
        <button class="smm-button smm-primary" data-action="edit" data-kind="product" data-id="">+ Add product</button></div>
      ${editing && !editing.id ? productForm({}) : ""}
      <div class="smm-list">${products.map((product) => editing?.id === product.id ? productForm(product) : `<article class="smm-card">
        <div class="smm-card-head"><div><h4>${escapeHtml(product.name)}</h4>
          ${product.url ? `<a class="smm-small-link" href="${escapeHtml(product.url)}" target="_blank" rel="noopener">${escapeHtml(product.url)}</a>` : ""}</div>
          <span class="smm-pill">${escapeHtml(product.status)}</span></div>
        ${product.description ? `<p>${escapeHtml(product.description)}</p>` : ""}
        <dl class="smm-facts">${product.audience ? `<div><dt>Audience</dt><dd>${escapeHtml(product.audience)}</dd></div>` : ""}${product.valueProposition ? `<div><dt>Value</dt><dd>${escapeHtml(product.valueProposition)}</dd></div>` : ""}</dl>
        ${view.editing?.kind === "compose" && view.editing.id === product.id ? composeForm(product, channels) : `<div class="smm-actions">
          <button class="smm-button smm-primary" data-action="compose" data-id="${escapeHtml(product.id)}" ${channels.length ? "" : "disabled title=\"Add a channel first\""}>Draft posts</button>
          <button class="smm-button" data-action="edit" data-kind="product" data-id="${escapeHtml(product.id)}">Edit</button>
          <button class="smm-button smm-danger" data-action="delete-product" data-id="${escapeHtml(product.id)}">Remove</button></div>`}
      </article>`).join("") || (editing ? "" : `<div class="smm-empty">No products yet.</div>`)}</div>`;
  }

  function productForm(product) {
    return `<form class="smm-card smm-form" data-form="product" data-id="${escapeHtml(product.id || "")}">
      <div class="smm-grid">
        ${field("name", "Name", product.name, { required: true })}
        ${field("url", "Product URL", product.url, { type: "url", placeholder: "https://" })}
        ${field("description", "Description", product.description, { textarea: true, wide: true })}
        ${field("audience", "Audience", product.audience)}
        ${field("valueProposition", "Value proposition", product.valueProposition)}
        ${field("keywords", "Keywords", (product.keywords || []).join(", "), { placeholder: "comma separated" })}
        ${select("status", "Status", product.status || "active", ["active", "paused", "archived"])}
      </div>
      <div class="smm-actions"><button class="smm-button smm-primary" type="submit">Save product</button>
        <button class="smm-button" type="button" data-action="cancel">Cancel</button></div></form>`;
  }

  function composeForm(product, channels) {
    return `<form class="smm-inline-form" data-form="compose" data-id="${escapeHtml(product.id)}">
      ${select("platform", "Channel", channels[0]?.platform || "", channels.map((channel) => [channel.platform, channel.label]))}
      ${select("count", "Drafts", "3", ["1", "2", "3", "4", "5"])}
      ${field("tone", "Tone", property()?.voice || "", { placeholder: "e.g. concise" })}
      <div class="smm-actions"><button class="smm-button smm-primary" type="submit">Draft</button>
        <button class="smm-button" type="button" data-action="cancel">Cancel</button></div></form>`;
  }

  // ---- Channels -------------------------------------------------------

  function channelsView(current) {
    const used = new Set(current.channels.map((channel) => channel.platform));
    const available = view.state.platforms.filter((platform) => !used.has(platform.id));
    const targets = scoped("publishingTargets").concat((view.state.publishingTargets || []).filter((target) => !target.propertyId));
    return `<p class="smm-muted">The channels ${escapeHtml(current.name)} posts to. Drafts can only be written for enabled channels.</p>
      <div class="smm-list">${current.channels.map((channel, index) => channelCard(current, channel, index)).join("") || `<div class="smm-empty">No channels yet. Add one below.</div>`}</div>
      <form class="smm-inline-form smm-add-channel" data-form="add-channel">
        ${select("platform", "Add a channel", available[0]?.id || "", [...available.map((platform) => [platform.id, platform.name]), ["custom", "Other…"]])}
        ${field("custom", "Custom platform name", "", { placeholder: "only for Other…" })}
        ${field("handle", "Account or page", "", { placeholder: "@handle or page name" })}
        <div class="smm-actions"><button class="smm-button smm-primary" type="submit">Add channel</button></div>
      </form>
      <h3 class="smm-subhead">Browser publishing targets</h3>
      <p class="smm-muted">Optional. A target lets Speck publish through a signed-in browser account instead of a webhook. Targets without a property serve every property.</p>
      <div class="smm-list">${targets.map((target) => view.editing?.kind === "target" && view.editing.id === target.id ? targetForm(current, target) : `<article class="smm-card smm-row">
        <div><h4>${escapeHtml(target.label)}</h4><p class="smm-muted">${escapeHtml(platformLabel(target.platform))} · ${escapeHtml(target.accountId)} · ${target.propertyId ? "this property" : "all properties"} · ${escapeHtml(target.status)}</p></div>
        <div class="smm-actions"><button class="smm-button" data-action="edit" data-kind="target" data-id="${escapeHtml(target.id)}">Edit</button>
          <button class="smm-button smm-danger" data-action="delete-target" data-id="${escapeHtml(target.id)}">Remove</button></div></article>`).join("")}</div>
      ${view.editing?.kind === "target" && !view.editing.id ? targetForm(current, {}) : `<button class="smm-button" data-action="edit" data-kind="target" data-id="">+ Add browser target</button>`}`;
  }

  function channelCard(current, channel, index) {
    const secret = view.secrets?.channels?.find((entry) => entry.platform === channel.platform);
    const status = !secret ? "" : secret.webhookUrl
      ? `<span class="smm-pill smm-ok">own webhook</span>`
      : secret.sharedWebhookUrl ? `<span class="smm-pill">shared webhook</span>` : `<span class="smm-pill smm-warn">no webhook</span>`;
    return `<article class="smm-card">
      <div class="smm-card-head"><div><h4>${escapeHtml(channel.label)}</h4><p class="smm-muted">${escapeHtml([channel.label === platformLabel(channel.platform) ? "" : platformLabel(channel.platform), channel.handle].filter(Boolean).join(" · ") || "No account named")}</p></div>
        <div class="smm-actions">${status}<label class="smm-switch" title="${channel.enabled ? "Enabled" : "Disabled"}"><input type="checkbox" data-change="channel-enabled" data-index="${index}" ${channel.enabled ? "checked" : ""}/><i></i></label></div></div>
      <form class="smm-inline-form" data-form="channel" data-index="${index}">
        ${field("label", "Label", channel.label)}
        ${field("handle", "Account or page", channel.handle)}
        ${field("notes", "Posting notes", channel.notes, { wide: true, placeholder: "rules, best times, hashtags…" })}
        <div class="smm-actions"><button class="smm-button" type="submit">Save</button>
          <button class="smm-button smm-danger" type="button" data-action="remove-channel" data-index="${index}">Remove</button></div>
      </form>
      ${secret ? `<details class="smm-details"><summary>Webhook publishing</summary>
        <p class="smm-muted">Stored in Speck Secrets as <code>${escapeHtml(secret.handles.url)}</code>${secret.sharedWebhookUrl ? `; falls back to <code>${escapeHtml(secret.sharedHandles.url)}</code>` : ""}. Values are never shown.</p>
        <form class="smm-inline-form" data-form="secret" data-platform="${escapeHtml(channel.platform)}">
          ${field("url", `Webhook URL ${secret.webhookUrl ? "(set — enter to replace, blank to clear)" : ""}`, "", { type: "url", placeholder: "https://" })}
          ${field("token", `Bearer token ${secret.webhookToken ? "(set)" : "(optional)"}`, "", { type: "password" })}
          <div class="smm-actions"><button class="smm-button" type="submit">Save webhook</button></div>
        </form></details>` : ""}
    </article>`;
  }

  function targetForm(current, target) {
    const channels = current.channels.map((channel) => [channel.platform, channel.label]);
    return `<form class="smm-card smm-form" data-form="target" data-id="${escapeHtml(target.id || "")}">
      <div class="smm-grid">
        ${select("platform", "Channel", target.platform || channels[0]?.[0] || "", channels.length ? channels : view.state.platforms.map((platform) => [platform.id, platform.name]))}
        ${field("accountId", "Browser account", target.accountId, { required: true })}
        ${field("label", "Label", target.label, { required: true })}
        ${select("scope", "Used by", target.id && !target.propertyId ? "all" : "property", [["property", `${current.name} only`], ["all", "All properties"]])}
        ${field("composerUrl", "Composer URL", target.composerUrl, { type: "url", required: true, wide: true })}
        ${field("bodySelector", "Body selector", target.bodySelector, { required: true })}
        ${field("submitSelector", "Submit selector", target.submitSelector, { required: true })}
        ${field("titleSelector", "Title selector", target.titleSelector)}
        ${select("status", "Status", target.status || "active", ["active", "paused", "archived"])}
      </div>
      <div class="smm-actions"><button class="smm-button smm-primary" type="submit">Save target</button>
        <button class="smm-button" type="button" data-action="cancel">Cancel</button></div></form>`;
  }

  // ---- Posts ----------------------------------------------------------

  function postsView() {
    const posts = scoped("posts");
    const counts = Object.fromEntries(POST_FILTERS.map((status) => [status, status === "all" ? posts.length : posts.filter((post) => post.status === status).length]));
    const shown = posts.filter((post) => view.postFilter === "all" || post.status === view.postFilter)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return `<div class="smm-filters">${POST_FILTERS.map((status) => `<button class="smm-tab smm-filter ${view.postFilter === status ? "active" : ""}" data-action="post-filter" data-id="${status}">${status}<span>${counts[status]}</span></button>`).join("")}</div>
      <div class="smm-list">${shown.map((post) => postCard(post)).join("") || `<div class="smm-empty">No ${view.postFilter === "all" ? "" : `${view.postFilter} `}posts. Draft some from the Products section.</div>`}</div>`;
  }

  function postCard(post, { compact = false } = {}) {
    const editable = ["draft", "approved"].includes(post.status) && !compact;
    const id = escapeHtml(post.id);
    const actions = [];
    if (post.status === "draft") actions.push(`<button class="smm-button smm-primary" data-action="post-status" data-status="approved" data-id="${id}">Approve</button>`);
    if (post.status === "approved") {
      actions.push(`<button class="smm-button smm-primary" data-action="publish" data-id="${id}">Publish…</button>`);
      actions.push(`<button class="smm-button" data-action="post-status" data-status="draft" data-id="${id}">Back to draft</button>`);
    }
    if (["approved", "submitted"].includes(post.status)) actions.push(`<button class="smm-button" data-action="verify" data-id="${id}">Mark published…</button>`);
    if (post.status !== "archived") actions.push(`<button class="smm-button" data-action="post-status" data-status="archived" data-id="${id}">Archive</button>`);
    actions.push(`<button class="smm-button smm-danger" data-action="delete-post" data-id="${id}">Delete</button>`);
    return `<article class="smm-card smm-post">
      <div class="smm-card-head"><div><span class="smm-pill">${escapeHtml(platformLabel(post.platform))}</span> <span class="smm-pill smm-status-${escapeHtml(post.status)}">${escapeHtml(post.status)}</span>
        <h4>${escapeHtml(post.title || "Untitled post")}</h4><p class="smm-muted">${escapeHtml(productName(post.productId))} · updated ${escapeHtml(when(post.updatedAt))}${post.publishedUrl ? ` · <a href="${escapeHtml(post.publishedUrl)}" target="_blank" rel="noopener">view post</a>` : ""}</p></div></div>
      ${editable ? `<form data-form="post" data-id="${id}" class="smm-post-form">
          <textarea name="body" rows="7" aria-label="Post text">${escapeHtml(post.body)}</textarea>
          <div class="smm-post-foot"><small class="smm-muted">${post.body.length} characters</small><button class="smm-button" type="submit">Save text</button></div>
        </form>` : `<p class="smm-post-body">${escapeHtml(compact ? post.body.slice(0, 280) + (post.body.length > 280 ? "…" : "") : post.body)}</p>`}
      ${post.status === "published" ? `<p class="smm-muted">${["views", "likes", "comments", "shares", "clicks"].map((key) => `${post.metrics?.[key] || 0} ${key}`).join(" · ")}</p>` : ""}
      ${compact ? `<div class="smm-actions"><button class="smm-link" data-action="section" data-id="posts">Open in Posts</button></div>` : `<div class="smm-actions">${actions.join("")}</div>`}
    </article>`;
  }

  // ---- Replies --------------------------------------------------------

  function repliesView() {
    const interactions = scoped("interactions").sort((left, right) =>
      (left.replyStatus === "needs-review" ? 0 : 1) - (right.replyStatus === "needs-review" ? 0 : 1) || right.updatedAt - left.updatedAt);
    return `<p class="smm-muted">Comments recorded on this property's posts, each with a suggested reply to review.</p>
      <div class="smm-list">${interactions.map((interaction) => `<article class="smm-card">
        <div class="smm-card-head"><div><h4>${escapeHtml(interaction.author || "Unknown")}</h4>
          <p class="smm-muted">${escapeHtml(platformLabel(interaction.platform))} · ${escapeHtml(interaction.sentiment)} · ${escapeHtml(interaction.intent)}${interaction.externalUrl ? ` · <a href="${escapeHtml(interaction.externalUrl)}" target="_blank" rel="noopener">open</a>` : ""}</p></div>
          <span class="smm-pill">${escapeHtml(interaction.replyStatus)}</span></div>
        <blockquote>${escapeHtml(interaction.text)}</blockquote>
        <form data-form="reply" data-id="${escapeHtml(interaction.id)}" class="smm-post-form">
          <textarea name="replyDraft" rows="3" aria-label="Reply">${escapeHtml(interaction.replyDraft)}</textarea>
          <div class="smm-post-foot">${select("replyStatus", "", interaction.replyStatus, REPLY_STATUSES)}<button class="smm-button" type="submit">Save reply</button></div>
        </form></article>`).join("") || `<div class="smm-empty">No comments recorded for this property yet.</div>`}</div>`;
  }

  // ---- Settings -------------------------------------------------------

  function settingsView(current) {
    const summary = current.summary || {};
    return `${propertyForm(current)}
      <section class="smm-card smm-danger-zone"><h4>Remove property</h4>
        <p class="smm-muted">Removes ${escapeHtml(current.name)} with its ${plural(summary.products || 0, "product")}, ${plural(summary.posts || 0, "post")}, opportunities, replies and property-only publishing targets. Secrets stay in Speck Secrets.</p>
        <button class="smm-button smm-danger" data-action="delete-property" data-id="${escapeHtml(current.id)}">Remove property</button></section>`;
  }

  function propertyForm(current) {
    return `<form class="smm-card smm-form" data-form="property" data-id="${escapeHtml(current.id || "")}">
      <div class="smm-grid">
        ${field("name", "Name", current.name, { required: true })}
        ${field("website", "Website", current.website, { type: "url", placeholder: "https://" })}
        ${field("description", "What it is", current.description, { textarea: true, wide: true })}
        ${field("audience", "Audience", current.audience)}
        ${field("voice", "Voice", current.voice, { placeholder: "e.g. friendly, local, concise" })}
        ${field("keywords", "Keywords", (current.keywords || []).join(", "), { placeholder: "comma separated" })}
        ${select("status", "Status", current.status || "active", ["active", "paused", "archived"])}
        ${field("guidelines", "Guidelines", current.guidelines, { textarea: true, wide: true, placeholder: "What posts for this property must or must not do" })}
        ${current.id ? "" : `<fieldset class="smm-wide smm-channel-picks"><legend>Channels</legend>${view.state.platforms.map((platform) =>
          `<label><input type="checkbox" name="channels" value="${escapeHtml(platform.id)}"/> ${escapeHtml(platform.name)}</label>`).join("")}</fieldset>`}
      </div>
      <div class="smm-actions"><button class="smm-button smm-primary" type="submit">${current.id ? "Save settings" : "Create property"}</button>
        ${current.id ? "" : `<button class="smm-button" type="button" data-action="cancel">Cancel</button>`}</div></form>`;
  }

  // ---- Form helpers ---------------------------------------------------

  function field(name, label, value = "", { textarea = false, wide = false, type = "text", placeholder = "", required = false } = {}) {
    const attrs = `name="${name}" placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""}`;
    return `<label class="smm-field ${wide || textarea ? "smm-wide" : ""}"><span>${escapeHtml(label)}</span>${textarea
      ? `<textarea ${attrs} rows="3">${escapeHtml(value || "")}</textarea>`
      : `<input type="${type}" ${attrs} value="${escapeHtml(value || "")}" autocomplete="off"/>`}</label>`;
  }

  function select(name, label, value, options) {
    const pairs = options.map((option) => Array.isArray(option) ? option : [option, option]);
    return `<label class="smm-field">${label ? `<span>${escapeHtml(label)}</span>` : ""}<select name="${name}">${pairs.map(([optionValue, optionLabel]) =>
      `<option value="${escapeHtml(optionValue)}" ${String(optionValue) === String(value) ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`).join("")}</select></label>`;
  }

  const values = (form) => Object.fromEntries([...new FormData(form).entries()].filter(([key]) => key !== "channels"));

  // ---- Events ---------------------------------------------------------

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || !root.contains(button)) return;
    const { action, id = "", kind = "", status = "", index } = button.dataset;
    const current = property();
    switch (action) {
      case "reload": return act(async () => {}, "Reloaded");
      case "select-property":
        view.propertyId = id; view.editing = null; writePreference("property", id);
        if (view.section === "channels") return act(async () => {});
        return render();
      case "new-property": view.editing = { kind: "property", id: "" }; return render();
      case "section":
        view.section = id; view.editing = null; writePreference("section", id);
        if (id === "channels") return loadSecrets().then(render);
        return render();
      case "post-filter": view.postFilter = id; return render();
      case "edit": view.editing = { kind, id }; return render();
      case "compose": view.editing = { kind: "compose", id }; return render();
      case "cancel": view.editing = null; return render();
      case "delete-product":
        if (!confirm("Remove this product? Its posts stay.")) return;
        return act(() => request(`/products/${encodeURIComponent(id)}`, { method: "DELETE" }), "Product removed");
      case "delete-target":
        if (!confirm("Remove this publishing target?")) return;
        return act(() => request(`/targets/${encodeURIComponent(id)}`, { method: "DELETE" }), "Target removed");
      case "delete-post":
        if (!confirm("Delete this post and its recorded replies?")) return;
        return act(() => request(`/posts/${encodeURIComponent(id)}`, { method: "DELETE" }), "Post deleted");
      case "delete-property":
        if (!confirm(`Remove ${current?.name} and everything that belongs to it? This cannot be undone.`)) return;
        return act(async () => { await request(`/properties/${encodeURIComponent(id)}`, { method: "DELETE" }); view.section = "overview"; }, "Property removed");
      case "post-status":
        return act(() => request(`/posts/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } }), `Post ${status === "approved" ? "approved" : status === "archived" ? "archived" : "moved to drafts"}`);
      case "verify": {
        const publishedUrl = prompt("Address of the published post:");
        if (!publishedUrl) return;
        return act(() => request(`/posts/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "published", publishedUrl, publishedAt: Date.now() } }), "Post marked published");
      }
      case "publish": {
        const post = view.state.posts.find((entry) => entry.id === id);
        if (!confirm(`Publish this post to ${platformLabel(post?.platform)} for ${current?.name} now?`)) return;
        return act(() => request(`/posts/${encodeURIComponent(id)}/publish`, { method: "POST", body: {} }),
          (result) => result.verificationRequired ? "Submitted. Mark it published once you have confirmed it is live." : "Published");
      }
      case "remove-channel": {
        const channels = current.channels.filter((_, position) => position !== Number(index));
        return act(() => saveProperty({ id: current.id, channels }), "Channel removed");
      }
      default: return undefined;
    }
  }

  function onChange(event) {
    const input = event.target;
    if (input.dataset?.change !== "channel-enabled") return;
    const current = property();
    const channels = current.channels.map((channel, position) => position === Number(input.dataset.index) ? { ...channel, enabled: input.checked } : channel);
    act(() => saveProperty({ id: current.id, channels }), input.checked ? "Channel enabled" : "Channel disabled");
  }

  const saveProperty = (body) => request("/properties", { method: "POST", body });

  function onSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = values(form);
    const current = property();
    const id = form.dataset.id || "";
    switch (form.dataset.form) {
      case "property": {
        if (!id) data.channels = new FormData(form).getAll("channels");
        return act(async () => {
          const { property: saved } = await saveProperty(id ? { ...data, id } : data);
          view.propertyId = saved.id; writePreference("property", saved.id);
          view.editing = null;
          if (!id) view.section = "products";
        }, id ? "Settings saved" : "Property created");
      }
      case "product":
        return act(async () => {
          await request("/products", { method: "POST", body: { ...data, ...(id ? { id } : {}), propertyId: current.id } });
          view.editing = null;
        }, "Product saved");
      case "compose":
        return act(async () => {
          const { posts } = await request("/posts/compose", { method: "POST", body: { ...data, productId: id, propertyId: current.id, count: Number(data.count) } });
          view.editing = null; view.section = "posts"; view.postFilter = "draft";
          return posts;
        }, (posts) => `${plural(posts.length, "draft")} written`);
      case "post":
        return act(() => request(`/posts/${encodeURIComponent(id)}`, { method: "PATCH", body: { body: data.body } }), "Post saved");
      case "reply":
        return act(() => request(`/interactions/${encodeURIComponent(id)}`, { method: "PATCH", body: data }), "Reply saved");
      case "add-channel": {
        const platform = data.platform === "custom" ? data.custom.trim() : data.platform;
        if (!platform) return notice("Name the platform for a custom channel.", true);
        return act(() => saveProperty({ id: current.id, channels: [...current.channels, { platform, handle: data.handle }] }), "Channel added");
      }
      case "channel": {
        const channels = current.channels.map((channel, position) => position === Number(form.dataset.index) ? { ...channel, ...data } : channel);
        return act(() => saveProperty({ id: current.id, channels }), "Channel saved");
      }
      case "secret": {
        const platform = form.dataset.platform;
        const path = `/properties/${encodeURIComponent(current.id)}/secrets`;
        const clearing = !data.url && !data.token;
        if (clearing && !confirm("Clear this channel's webhook URL and token?")) return;
        const kinds = clearing ? [["url", ""], ["token", ""]] : [["url", data.url], ["token", data.token]].filter(([, value]) => value);
        return act(async () => {
          for (const [kind, value] of kinds) await request(path, { method: "POST", body: { platform, kind, value } });
        }, clearing ? "Webhook cleared" : "Webhook saved");
      }
      case "target": {
        const { scope, ...target } = data;
        return act(async () => {
          await request("/targets", { method: "POST", body: { ...target, ...(id ? { id } : {}), propertyId: scope === "all" ? "" : current.id } });
          view.editing = null;
        }, "Target saved");
      }
      default: return undefined;
    }
  }

  return { load, render };
}

function readPreference(key) {
  try { return localStorage.getItem(`speck.social.${key}`) || ""; } catch { return ""; }
}

function writePreference(key, value) {
  try { localStorage.setItem(`speck.social.${key}`, value); } catch { /* preferences are optional */ }
}

function injectStyles() {
  if (document.getElementById("smm-styles")) return;
  const style = document.createElement("style");
  style.id = "smm-styles";
  style.textContent = `
.smm { --smm-line: var(--line, rgba(214,205,255,.12)); --smm-ink: var(--ink, #f3f0ff); --smm-muted: var(--muted, #9e9ab4); --smm-accent: var(--cyan, #75e6dc); --smm-violet: var(--lavender, #d8cbff); --smm-rose: var(--rose, #ff8eaa); --smm-gold: var(--gold, #f5cd78); color: var(--smm-ink); }
.smm.smm-busy { cursor: progress; }
.smm.smm-busy button { pointer-events: none; opacity: .7; }
.smm-layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 18px; align-items: start; }
.smm-sidebar { position: sticky; top: 0; display: grid; gap: 10px; min-width: 0; }
.smm-sidebar-head, .smm-head, .smm-section-head, .smm-card-head, .smm-post-foot { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.smm-sidebar-head { align-items: center; }
.smm-property-list, .smm-list { display: grid; gap: 10px; }
.smm-property { display: grid; gap: 6px; width: 100%; padding: 13px 14px; text-align: left; color: inherit; border: 1px solid var(--smm-line); border-radius: 15px; background: rgba(255,255,255,.03); cursor: pointer; }
.smm-property:hover { background: rgba(255,255,255,.055); }
.smm-property.active { border-color: rgba(117,230,220,.5); background: rgba(117,230,220,.07); }
.smm-property-name { font-weight: 700; font-size: 13px; }
.smm-property-name em { font-style: normal; font-weight: 500; color: var(--smm-muted); font-size: 10px; }
.smm-property-meta { color: var(--smm-muted); font-size: 10px; }
.smm-property-meta b { color: var(--smm-gold); font-weight: 600; }
.smm-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.smm-chips i { font-style: normal; font-size: 9px; padding: 2px 7px; border-radius: 999px; background: rgba(216,203,255,.1); color: var(--smm-violet); }
.smm-chips i.smm-chip-empty { background: none; color: var(--smm-muted); padding-left: 0; }
.smm-main { min-width: 0; }
.smm-head { margin-bottom: 12px; }
.smm-head h2 { margin: 2px 0 4px; font-size: 20px; }
.smm-head a, .smm-card a { color: var(--smm-accent); }
.smm-eyebrow { color: var(--smm-accent); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
.smm-muted { margin: 0; color: var(--smm-muted); font-size: 11px; line-height: 1.55; }
.smm-tabs, .smm-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.smm-tab { display: inline-flex; align-items: center; gap: 7px; padding: 7px 13px; color: var(--smm-muted); border: 1px solid var(--smm-line); border-radius: 999px; background: rgba(255,255,255,.03); cursor: pointer; font-size: 12px; text-transform: capitalize; }
.smm-tab span { min-width: 18px; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,.08); font-size: 9px; text-align: center; }
.smm-tab.active { color: #10121d; border-color: transparent; background: linear-gradient(135deg, var(--smm-accent), var(--smm-violet)); }
.smm-tab.active span { background: rgba(0,0,0,.14); }
.smm-section { display: grid; gap: 12px; }
.smm-section-head { align-items: center; }
.smm-subhead { margin: 10px 0 0; font-size: 14px; }
.smm-card { padding: 16px; border: 1px solid var(--smm-line); border-radius: 16px; background: rgba(255,255,255,.03); display: grid; gap: 10px; }
.smm-card h4 { margin: 0 0 3px; font-size: 14px; overflow-wrap: anywhere; }
.smm-card > p { margin: 0; color: var(--smm-muted); font-size: 12px; line-height: 1.55; }
.smm-row { grid-template-columns: 1fr auto; align-items: center; }
.smm-small-link { font-size: 11px; overflow-wrap: anywhere; }
.smm-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 0; }
.smm-facts dt { color: var(--smm-muted); font-size: 9px; text-transform: uppercase; letter-spacing: .1em; }
.smm-facts dd { margin: 2px 0 0; font-size: 12px; }
.smm-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.smm-button { padding: 8px 13px; color: var(--smm-ink); border: 1px solid var(--smm-line); border-radius: 11px; background: rgba(255,255,255,.055); cursor: pointer; font-size: 12px; }
.smm-button:hover:not(:disabled) { background: rgba(255,255,255,.09); }
.smm-button:disabled { opacity: .45; cursor: not-allowed; }
.smm-button.smm-primary { color: #0c0b14; border-color: transparent; background: linear-gradient(135deg, var(--smm-violet), var(--smm-accent)); font-weight: 700; }
.smm-button.smm-danger { color: var(--smm-rose); border-color: rgba(255,142,170,.3); background: rgba(255,142,170,.05); }
.smm-button.smm-small { padding: 5px 10px; font-size: 11px; }
.smm-link { padding: 0; border: 0; background: none; color: var(--smm-accent); cursor: pointer; font-size: 11px; text-decoration: underline; }
.smm-pill { display: inline-block; padding: 2px 8px; border: 1px solid var(--smm-line); border-radius: 999px; color: var(--smm-violet); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
.smm-pill.smm-ok, .smm-status-published { color: var(--smm-accent); border-color: rgba(117,230,220,.35); }
.smm-pill.smm-warn, .smm-status-submitted { color: var(--smm-gold); border-color: rgba(245,205,120,.35); }
.smm-status-approved { color: #b9f5a7; border-color: rgba(185,245,167,.35); }
.smm-status-archived { color: var(--smm-muted); }
.smm-form .smm-grid, .smm-inline-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; align-items: end; }
.smm-inline-form .smm-actions { align-self: end; }
.smm-field { display: grid; gap: 5px; min-width: 0; color: var(--smm-muted); font-size: 10px; letter-spacing: .04em; }
.smm-wide { grid-column: 1 / -1; }
.smm input:not([type=checkbox]), .smm textarea, .smm select { width: 100%; padding: 9px 11px; color: var(--smm-ink); border: 1px solid var(--smm-line); border-radius: 11px; background: rgba(255,255,255,.04); font: inherit; font-size: 12px; resize: vertical; }
.smm select option { background: #11121f; }
.smm-channel-picks { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 12px; border: 1px solid var(--smm-line); border-radius: 12px; color: var(--smm-ink); font-size: 12px; }
.smm-channel-picks legend { color: var(--smm-muted); font-size: 10px; padding: 0 4px; }
.smm-channel-picks label { display: inline-flex; gap: 6px; align-items: center; }
.smm-metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.smm-metric { display: grid; gap: 4px; padding: 14px; border: 1px solid var(--smm-line); border-radius: 15px; background: rgba(255,255,255,.03); }
.smm-metric strong { font-size: 24px; }
.smm-metric small { color: var(--smm-muted); font-size: 10px; }
.smm-callout { padding: 12px 14px; border: 1px solid rgba(245,205,120,.3); border-radius: 14px; background: rgba(245,205,120,.05); display: grid; gap: 4px; }
.smm-callout p { margin: 0; font-size: 12px; }
.smm-post-body { white-space: pre-wrap; margin: 0; font-size: 12px; line-height: 1.6; color: var(--smm-ink) !important; }
.smm-post-form { display: grid; gap: 8px; }
.smm-post-form textarea { line-height: 1.6; }
.smm-post-foot { align-items: center; }
.smm-post-foot .smm-field { min-width: 150px; }
.smm blockquote { margin: 0; padding: 8px 12px; border-left: 2px solid var(--smm-violet); color: var(--smm-ink); font-size: 12px; }
.smm-details summary { cursor: pointer; color: var(--smm-accent); font-size: 12px; }
.smm-details[open] { display: grid; gap: 8px; }
.smm code { overflow-wrap: anywhere; font-size: 10px; padding: 1px 5px; border-radius: 6px; background: rgba(255,255,255,.07); }
.smm-switch { position: relative; display: inline-block; width: 38px; height: 22px; }
.smm-switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.smm-switch i { position: absolute; inset: 0; border-radius: 999px; background: rgba(255,255,255,.1); border: 1px solid var(--smm-line); pointer-events: none; transition: background .15s; }
.smm-switch i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--smm-muted); transition: transform .15s, background .15s; }
.smm-switch input:checked + i { background: rgba(117,230,220,.25); }
.smm-switch input:checked + i::after { transform: translateX(16px); background: var(--smm-accent); }
.smm-switch input:focus-visible + i { outline: 2px solid var(--smm-accent); outline-offset: 2px; }
.smm-empty { padding: 28px; border: 1px dashed var(--smm-line); border-radius: 16px; color: var(--smm-muted); text-align: center; font-size: 12px; line-height: 1.6; }
.smm-empty h3 { margin: 0 0 6px; color: var(--smm-ink); }
.smm-empty p { margin: 0 0 14px; }
.smm-danger-zone { border-color: rgba(255,142,170,.22); }
@media (max-width: 860px) {
  .smm-layout { grid-template-columns: minmax(0, 1fr); }
  .smm-sidebar { position: static; }
  .smm-property-list { grid-auto-flow: column; grid-auto-columns: minmax(200px, 70%); overflow-x: auto; padding-bottom: 4px; contain: inline-size; }
  .smm-row { grid-template-columns: 1fr; }
}`;
  document.head.appendChild(style);
}
