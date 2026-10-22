# Optional assistant plugins

Speck loads the local plugins in this directory through Genesis. The migrated plugins are independent of the cognitive core and can be enabled or disabled in the Plugins view. Their entrypoint hashes are pinned in `.runtime/plugin-trust.json`; update that file after reviewing a plugin change.

## Social Media Manager

The plugin manages several **properties**: the businesses, brands or sites you promote. Each property has its own products, channels, voice, guidelines, posts, opportunities and replies. Its channels are the platforms it posts to. Drafts can only be written for a property's enabled channels; without a platform, a draft goes to the property's first channel. Records saved before properties existed join a property called "Default property", which can be renamed.

The **Social** view in Speck's rail is the interface. Use it to create properties, edit their settings and channel lists, add products, draft posts, edit, approve and publish them, review replies and set each channel's webhook. Its data routes under `/api/plugins/social-media-manager/` need the admin token. Pressing Publish in the view is the approval for that post.

Workers use the `social_*` tools. Pass `propertyId` (an id or a name) when more than one property exists. Drafts must be marked `approved` before `social_publish_post` can submit them. Publishing through the tool is high-risk and uses Speck's normal approval flow.

Publishing uses an installed `browser.externalAction` capability when a publishing target applies. That is a target named by ID, or an active target for the post's platform. A property's own target is preferred over one shared by all properties. Otherwise, publishing uses a webhook: set `social.<property-id>.<platform>.webhook-url` in Speck Secrets (the Channels section can set it), or `social.<platform>.webhook-url` for all properties. Each URL must be an HTTPS endpoint. The matching `...webhook-token` adds bearer authentication. The endpoint receives JSON with `postId`, `propertyId`, `platform`, `title`, `body`, and `productId`. It should return JSON containing a published `url`, `publishedUrl`, or `verified: true`. Browser publication requires `verified: true` from the adapter. Without verification, Speck marks the post `submitted` so it cannot be sent twice accidentally; confirm it with `social_update_post` and a `publishedUrl`. The plugin does not import the archive's hard-coded campaign, image generator, or autonomous publishing schedule.

## AirChat

Set `airchat.url` and `airchat.token` in Speck Secrets. The `airchat_*` tools expose messages, tasks, shared notes, agent discovery and fleet models through the archived MCP client. Outbound actions use Speck's normal approval flow. Inbound board content is available through read tools; automatic mention ingestion is not enabled, so external agents cannot silently create Speck workers.

The plugins keep their state under the Genesis plugin runtime. No archived credentials or live campaign records are copied into this repository.

## Information Agent

The `info_agent_*` tools save interests and public web sources, scan due sources on request, and list or acknowledge change summaries. This is useful for competitor research and social campaign monitoring. Source fetching checks host addresses and redirects, has a 25-second timeout and a 1 MB response limit. It does not run autonomous background scans.
