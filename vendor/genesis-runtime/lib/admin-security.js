import crypto from "crypto";

// Plugins can register arbitrary mutating routes under /api/*, and core has no way to know
// about them in advance — so the safe default is "protect everything under /api/* for unsafe
// methods, then explicitly exempt the handful of routes that authenticate themselves" rather
// than an opt-in allowlist a plugin author could easily forget to extend.
const DEFAULT_UI_SESSION_PROTECTED_PREFIX = "/api";

const DEFAULT_UI_SESSION_PUBLIC_PATHS = [
  "/api/admin-token",
  "/api/health",
  "/api/compat",
  "/api/security/unlock",
  "/api/security/relock",
  "/api/security/server-unlock",
  "/api/security/claim-server-unlock"
];

const DEFAULT_INTAKE_RATE_LIMIT_PATHS = [];

export function createAdminSecurity({
  port,
  protectedPrefix = DEFAULT_UI_SESSION_PROTECTED_PREFIX,
  publicPaths = DEFAULT_UI_SESSION_PUBLIC_PATHS,
  rateLimitPaths = DEFAULT_INTAKE_RATE_LIMIT_PATHS,
  adminUiToken = crypto.randomBytes(24).toString("hex"),
  getVoiceProfileCount = () => 0,
  sessionInactivityMs = Math.max(
    60_000,
    Math.min(Number(process.env.GENESIS_UI_LOCK_INACTIVITY_MS || 30 * 60_000), 24 * 60 * 60_000)
  ),
  serverUnlockToken = String(process.env.GENESIS_SERVER_UNLOCK_TOKEN || crypto.randomBytes(18).toString("hex")).trim(),
  rateLimitWindowMs = Math.max(
    1000,
    Math.min(Number(process.env.GENESIS_RATE_LIMIT_WINDOW_MS || 60_000), 10 * 60 * 1000)
  ),
  rateLimitMax = Math.max(
    5,
    Math.min(Number(process.env.GENESIS_RATE_LIMIT_MAX || 40), 500)
  )
} = {}) {
  const normalizedPort = Number(port || process.env.PORT || 3220);
  const publicPathSet = new Set(Array.isArray(publicPaths) ? publicPaths : []);
  const rateLimitPathSet = new Set(Array.isArray(rateLimitPaths) ? rateLimitPaths : []);
  const rateLimitBuckets = new Map();
  const uiSessions = new Map();
  const serverUnlockTickets = [];

  function isSafeRequestMethod(method = "GET") {
    const normalized = String(method || "GET").trim().toUpperCase();
    return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS";
  }

  function isLoopbackAddress(value = "") {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return normalized === "::1"
      || normalized === "127.0.0.1"
      || normalized.startsWith("::ffff:127.0.0.1");
  }

  function isLoopbackRequest(req = {}) {
    return isLoopbackAddress(
      req.socket?.remoteAddress
        || req.connection?.remoteAddress
        || req.ip
        || ""
    );
  }

  function isTrustedLocalOrigin(origin = "") {
    const normalized = String(origin || "").trim();
    if (!normalized) {
      return false;
    }
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:") {
        return false;
      }
      const originPort = String(parsed.port || "80").trim();
      if (originPort !== String(normalizedPort)) {
        return false;
      }
      return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }

  function isTrustedSameHostOrigin(origin = "", req = {}) {
    const normalized = String(origin || "").trim();
    const requestHost = String(req.headers?.host || "").trim().toLowerCase();
    if (!normalized || !requestHost) {
      return false;
    }
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      return String(parsed.host || "").trim().toLowerCase() === requestHost;
    } catch {
      return false;
    }
  }

  function isTrustedLocalRequestOrigin(req = {}) {
    const origin = String(req.headers?.origin || "").trim();
    const referer = String(req.headers?.referer || "").trim();
    if (origin) {
      return isTrustedLocalOrigin(origin) || isTrustedSameHostOrigin(origin, req);
    }
    if (referer) {
      return isTrustedLocalOrigin(referer) || isTrustedSameHostOrigin(referer, req);
    }
    return false;
  }

  function isValidAdminToken(value = "") {
    const token = String(value || "").trim();
    if (!token) {
      return false;
    }
    const expected = Buffer.from(adminUiToken);
    const provided = Buffer.from(token);
    return expected.length === provided.length
      && crypto.timingSafeEqual(expected, provided);
  }

  function validateAdminRequest(req = {}) {
    const hasTrustedOrigin = isTrustedLocalRequestOrigin(req);
    if (!isLoopbackRequest(req) && !hasTrustedOrigin) {
      return false;
    }
    if (!isSafeRequestMethod(req.method) && !hasTrustedOrigin) {
      return false;
    }
    const token = String(req.headers?.["x-admin-token"] || "").trim();
    return isValidAdminToken(token);
  }

  function getActiveVoiceProfileCount() {
    return Math.max(0, Number(getVoiceProfileCount() || 0));
  }

  function isUiLockEnabled() {
    return getActiveVoiceProfileCount() > 0;
  }

  function sessionIdForRequest(req = {}) {
    const clientSessionId = String(req.headers?.["x-genesis-client-session"] || "").trim();
    if (clientSessionId) {
      return clientSessionId.slice(0, 160);
    }
    const token = String(req.headers?.["x-admin-token"] || "").trim();
    return token ? `admin:${token}` : "anonymous";
  }

  function getActiveServerUnlockTicket(now = Date.now()) {
    while (serverUnlockTickets.length > 8) {
      serverUnlockTickets.shift();
    }
    return serverUnlockTickets.find((ticket) =>
      ticket
      && ticket.used !== true
      && Number(ticket.expiresAt || 0) > now
    ) || null;
  }

  function getUiSession(req = {}) {
    const sessionId = sessionIdForRequest(req);
    const current = uiSessions.get(sessionId);
    return current && typeof current === "object" ? current : {
      unlocked: false,
      unlockedAt: 0,
      lastActivityAt: 0,
      unlockedBy: ""
    };
  }

  function getUiSessionStatus(req = {}, now = Date.now()) {
    const lockEnabled = isUiLockEnabled();
    const sessionId = sessionIdForRequest(req);
    const session = getUiSession(req);
    const inactiveForMs = Math.max(0, now - Number(session.lastActivityAt || session.unlockedAt || 0));
    const expired = lockEnabled
      && session.unlocked === true
      && Number(session.lastActivityAt || session.unlockedAt || 0) > 0
      && inactiveForMs > sessionInactivityMs;
    if (expired) {
      uiSessions.set(sessionId, {
        ...session,
        unlocked: false,
        lockedAt: now,
        lockedReason: "inactive"
      });
    }
    const effectiveSession = expired ? getUiSession(req) : session;
    return {
      lockEnabled,
      unlocked: !lockEnabled || effectiveSession.unlocked === true,
      inactivityMs: sessionInactivityMs,
      inactiveForMs: lockEnabled && effectiveSession.unlocked === true ? inactiveForMs : 0,
      voiceProfileCount: getActiveVoiceProfileCount(),
      recoveryUnlockAvailable: Boolean(getActiveServerUnlockTicket(now)),
      unlockedAt: Number(effectiveSession.unlockedAt || 0),
      lastActivityAt: Number(effectiveSession.lastActivityAt || 0),
      unlockedBy: String(effectiveSession.unlockedBy || "")
    };
  }

  function unlockUiSession(req = {}, { by = "voice", sourceIdentity = null } = {}) {
    const now = Date.now();
    const session = {
      unlocked: true,
      unlockedAt: now,
      lastActivityAt: now,
      unlockedBy: String(by || "voice").trim() || "voice",
      sourceIdentity: sourceIdentity && typeof sourceIdentity === "object" ? sourceIdentity : null
    };
    uiSessions.set(sessionIdForRequest(req), session);
    return getUiSessionStatus(req, now);
  }

  function relockUiSession(req = {}, reason = "manual") {
    const now = Date.now();
    const session = getUiSession(req);
    uiSessions.set(sessionIdForRequest(req), {
      ...session,
      unlocked: false,
      lockedAt: now,
      lockedReason: String(reason || "manual").trim() || "manual"
    });
    return getUiSessionStatus(req, now);
  }

  function noteUnlockedActivity(req = {}) {
    const status = getUiSessionStatus(req);
    if (!status.lockEnabled || !status.unlocked) {
      return status;
    }
    const session = getUiSession(req);
    uiSessions.set(sessionIdForRequest(req), {
      ...session,
      lastActivityAt: Date.now()
    });
    return getUiSessionStatus(req);
  }

  function validateUnlockedAdminRequest(req = {}) {
    if (!validateAdminRequest(req)) {
      return { ok: false, status: 403, error: "Admin token required" };
    }
    const sessionStatus = getUiSessionStatus(req);
    if (sessionStatus.lockEnabled && !sessionStatus.unlocked) {
      return { ok: false, status: 423, error: "Admin UI is locked. Unlock with a trusted voice command." };
    }
    noteUnlockedActivity(req);
    return { ok: true, status: 200, error: "", sessionStatus };
  }

  function isValidServerUnlockToken(value = "") {
    const token = String(value || "").trim();
    if (!token || !serverUnlockToken) {
      return false;
    }
    const expected = Buffer.from(serverUnlockToken);
    const provided = Buffer.from(token);
    return expected.length === provided.length
      && crypto.timingSafeEqual(expected, provided);
  }

  function rateLimitKeyForRequest(req = {}, scope = "intake") {
    const address = String(req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || "unknown").trim().toLowerCase();
    const method = String(req.method || "GET").trim().toUpperCase();
    const routePath = String(req.path || req.originalUrl || "").trim().toLowerCase();
    return `${scope}:${address}:${method}:${routePath}`;
  }

  function checkSlidingWindowRateLimit(req = {}, {
    scope = "intake",
    maxRequests = rateLimitMax,
    windowMs = rateLimitWindowMs
  } = {}) {
    const now = Date.now();
    const key = rateLimitKeyForRequest(req, scope);
    const threshold = now - windowMs;
    const prior = Array.isArray(rateLimitBuckets.get(key))
      ? rateLimitBuckets.get(key).filter((timestamp) => Number(timestamp || 0) > threshold)
      : [];
    if (prior.length >= maxRequests) {
      const retryAfterMs = Math.max(1000, windowMs - (now - prior[0]));
      rateLimitBuckets.set(key, prior);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
      };
    }
    prior.push(now);
    rateLimitBuckets.set(key, prior);
    return {
      allowed: true,
      retryAfterSeconds: 0
    };
  }

  function registerAdminSecurityMiddleware(app) {
    app.get("/api/admin-token", (req, res) => {
      if (!isTrustedLocalRequestOrigin(req)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      res.json({ ok: true, token: adminUiToken });
    });

    app.get("/api/security/session", (req, res) => {
      if (!validateAdminRequest(req)) {
        return res.status(403).json({ ok: false, error: "Admin token required" });
      }
      res.json({ ok: true, session: getUiSessionStatus(req) });
    });

    app.post("/api/security/unlock", (req, res) => {
      if (!validateAdminRequest(req)) {
        return res.status(403).json({ ok: false, error: "Admin token required" });
      }
      if (!isUiLockEnabled()) {
        return res.json({ ok: true, session: getUiSessionStatus(req), message: "No voice profile is recorded; UI lock is disabled." });
      }
      const sourceIdentity = req.body?.sourceIdentity && typeof req.body.sourceIdentity === "object"
        ? req.body.sourceIdentity
        : null;
      const trusted = String(sourceIdentity?.kind || "") === "voice"
        && String(sourceIdentity?.trustLevel || "").trim().toLowerCase() === "trusted";
      if (!trusted) {
        return res.status(403).json({ ok: false, error: "Trusted voice validation required" });
      }
      res.json({ ok: true, session: unlockUiSession(req, { by: "voice", sourceIdentity }) });
    });

    app.post("/api/security/relock", (req, res) => {
      if (!validateAdminRequest(req)) {
        return res.status(403).json({ ok: false, error: "Admin token required" });
      }
      res.json({ ok: true, session: relockUiSession(req, "manual") });
    });

    app.post("/api/security/server-unlock", (req, res) => {
      if (!isLoopbackRequest(req)) {
        return res.status(403).json({ ok: false, error: "Server unlock is only available on loopback." });
      }
      const token = String(req.headers?.["x-genesis-server-unlock"] || req.body?.token || "").trim();
      if (!isValidServerUnlockToken(token)) {
        return res.status(403).json({ ok: false, error: "Server unlock token required" });
      }
      const now = Date.now();
      const ticket = {
        id: crypto.randomBytes(12).toString("hex"),
        createdAt: now,
        expiresAt: now + 5 * 60_000,
        used: false
      };
      serverUnlockTickets.push(ticket);
      res.json({
        ok: true,
        recoveryUnlock: {
          available: true,
          expiresAt: ticket.expiresAt
        },
        session: getUiSessionStatus(req, now)
      });
    });

    app.post("/api/security/claim-server-unlock", (req, res) => {
      if (!validateAdminRequest(req)) {
        return res.status(403).json({ ok: false, error: "Admin token required" });
      }
      const ticket = getActiveServerUnlockTicket();
      if (!ticket) {
        return res.status(404).json({ ok: false, error: "No server recovery unlock is available." });
      }
      ticket.used = true;
      ticket.usedAt = Date.now();
      res.json({ ok: true, session: unlockUiSession(req, { by: "server" }) });
    });

    app.use("/api/plugins", (req, res, next) => {
      if (String(req.method || "GET").trim().toUpperCase() === "GET" && String(req.path || "").trim() === "/list") {
        if (!validateAdminRequest(req)) {
          return res.status(403).json({ ok: false, error: "Admin token required" });
        }
        return next();
      }
      const validation = validateUnlockedAdminRequest(req);
      if (!validation.ok) {
        return res.status(validation.status).json({ ok: false, error: validation.error });
      }
      next();
    });

    app.use(protectedPrefix, (req, res, next) => {
      if (isSafeRequestMethod(req.method)) {
        return next();
      }
      // req.path is relative to the /api mount point here, so compare against the
      // original absolute path (minus query string) rather than req.path.
      const requestPath = String(req.originalUrl || req.path || "").split("?")[0].trim();
      if (publicPathSet.has(requestPath)) {
        return next();
      }
      const validation = validateUnlockedAdminRequest(req);
      if (!validation.ok) {
        return res.status(validation.status).json({ ok: false, error: validation.error });
      }
      next();
    });

    app.use((req, res, next) => {
      if (!rateLimitPathSet.has(String(req.path || "").trim())) {
        return next();
      }
      if (String(req.method || "GET").trim().toUpperCase() !== "POST") {
        return next();
      }
      const rateLimit = checkSlidingWindowRateLimit(req);
      if (!rateLimit.allowed) {
        res.set("Retry-After", String(rateLimit.retryAfterSeconds));
        return res.status(429).json({
          ok: false,
          error: "Too many intake requests. Please slow down and try again shortly."
        });
      }
      next();
    });
  }

  return {
    adminUiToken,
    checkSlidingWindowRateLimit,
    getUiSessionStatus,
    isSafeRequestMethod,
    isTrustedLocalRequestOrigin,
    noteUnlockedActivity,
    registerAdminSecurityMiddleware,
    relockUiSession,
    serverUnlockToken,
    unlockUiSession,
    validateUnlockedAdminRequest,
    validateAdminRequest
  };
}
