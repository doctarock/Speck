export function createHttpHooks({ getPluginManager }) {
  let requestSequence = 0;

  function compactHookText(value = "", maxLength = 180) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
  }

  function sanitizeHookToken(value = "") {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function summarizeHookValue(value = null) {
    if (value == null) {
      return "";
    }
    if (typeof value === "string") {
      return compactHookText(value, 220);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `array:${value.length}`;
    }
    if (typeof value === "object") {
      const keys = Object.keys(value).slice(0, 10);
      return `object:${keys.join(",")}`;
    }
    return compactHookText(String(value), 120);
  }

  function summarizeHookResponsePayload(payload = undefined) {
    if (payload == null) {
      return null;
    }
    if (Buffer.isBuffer(payload)) {
      return {
        kind: "buffer",
        size: payload.length
      };
    }
    if (typeof payload === "string") {
      return {
        kind: "text",
        preview: compactHookText(payload, 220)
      };
    }
    if (Array.isArray(payload)) {
      return {
        kind: "array",
        size: payload.length
      };
    }
    if (typeof payload === "object") {
      return {
        kind: "json",
        ok: payload.ok === true ? true : payload.ok === false ? false : null,
        keys: Object.keys(payload).slice(0, 20),
        error: compactHookText(String(payload.error || payload.message || "").trim(), 220),
        code: compactHookText(String(payload.code || "").trim(), 64),
        taskId: compactHookText(String(payload.taskId || payload?.task?.id || "").trim(), 80),
        eventType: compactHookText(String(payload.type || "").trim(), 80),
        count: Number(payload.count || payload.syncedCount || payload.removedCount || 0) || 0
      };
    }
    return {
      kind: typeof payload,
      value: compactHookText(String(payload), 120)
    };
  }

  function summarizeHookRequestBody(payload = undefined) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const keys = Object.keys(payload).slice(0, 20);
    return {
      keys,
      message: compactHookText(String(payload.message || "").trim(), 220),
      taskId: compactHookText(String(payload.taskId || "").trim(), 80),
      sessionId: compactHookText(String(payload.sessionId || "").trim(), 80),
      action: compactHookText(String(payload.action || payload.status || "").trim(), 80)
    };
  }

  function classifySubsystemsForPath(pathname = "", method = "GET") {
    const normalizedPath = String(pathname || "").trim().toLowerCase();
    const normalizedMethod = String(method || "GET").trim().toUpperCase() || "GET";
    const subsystems = new Set();
    if (!normalizedPath) {
      return ["runtime"];
    }
    // Genesis core only knows about its own baseline routes. Everything else
    // (queue/cron/brains/voice/... style subsystems) is classified by whichever
    // plugin registers the "subsystem:classify" capability below.
    if (normalizedPath.startsWith("/events/")) {
      subsystems.add("runtime");
      subsystems.add("events");
    }
    if (normalizedPath.startsWith("/api/runtime/")) {
      subsystems.add("runtime");
    }
    if (normalizedPath.startsWith("/api/plugins/")) {
      subsystems.add("plugins");
    }
    if (normalizedPath.startsWith("/api/security/") || normalizedPath.startsWith("/api/admin-token")) {
      subsystems.add("admin");
    }
    if (normalizedPath.startsWith("/api/")) {
      subsystems.add("api");
    }
    if (!subsystems.size) {
      subsystems.add("runtime");
    }
    const coreSubsystems = [...subsystems]
      .map((entry) => sanitizeHookToken(entry))
      .filter(Boolean);
    const pluginManager = getPluginManager();
    const classifyWithPlugin = typeof pluginManager?.getCapability === "function"
      ? pluginManager.getCapability("subsystem:classify")
      : null;
    if (typeof classifyWithPlugin !== "function") {
      return coreSubsystems;
    }
    try {
      const pluginSubsystems = classifyWithPlugin({
        path: normalizedPath,
        method: normalizedMethod,
        subsystems: coreSubsystems
      });
      if (!Array.isArray(pluginSubsystems)) {
        return coreSubsystems;
      }
      return [...new Set(
        pluginSubsystems
          .map((entry) => sanitizeHookToken(entry))
          .filter(Boolean)
      )];
    } catch {
      return coreSubsystems;
    }
  }

  function requestTrackingMiddleware(req, res, next) {
    const requestPath = String(req.path || "").trim();
    if (!requestPath.startsWith("/api/") && !requestPath.startsWith("/events/")) {
      return next();
    }
    const startedAt = Date.now();
    requestSequence = (requestSequence + 1) % 1_000_000;
    const requestId = `rq-${startedAt.toString(36)}-${requestSequence.toString(36)}`;
    const method = String(req.method || "GET").trim().toUpperCase() || "GET";
    const subsystems = classifySubsystemsForPath(requestPath, method);
    const startedPayload = {
      requestId,
      method,
      path: requestPath,
      queryKeys: Object.keys(req.query || {}).slice(0, 20).map((entry) => String(entry || "").trim()).filter(Boolean),
      subsystemCount: subsystems.length,
      subsystems,
      body: summarizeHookRequestBody(req.body),
      at: startedAt
    };

    const pluginManager = getPluginManager();
    void pluginManager.runHook("http:request-started", startedPayload);
    for (const subsystem of subsystems) {
      void pluginManager.runHook(`subsystem:${subsystem}:request-started`, startedPayload);
    }

    let responseSummary = null;
    const originalJson = typeof res.json === "function" ? res.json.bind(res) : null;
    if (originalJson) {
      res.json = (payload) => {
        responseSummary = summarizeHookResponsePayload(payload);
        return originalJson(payload);
      };
    }
    const originalSend = typeof res.send === "function" ? res.send.bind(res) : null;
    if (originalSend) {
      res.send = (payload) => {
        if (responseSummary == null) {
          responseSummary = summarizeHookResponsePayload(payload);
        }
        return originalSend(payload);
      };
    }

    let finalized = false;
    const finalize = (phase = "finish") => {
      if (finalized) {
        return;
      }
      finalized = true;
      const completedPayload = {
        ...startedPayload,
        at: Date.now(),
        phase: sanitizeHookToken(phase) || "finish",
        durationMs: Date.now() - startedAt,
        statusCode: Number(res.statusCode || 0),
        ok: Number(res.statusCode || 0) > 0 && Number(res.statusCode || 0) < 400,
        response: responseSummary
      };
      void pluginManager.runHook("http:request-completed", completedPayload);
      for (const subsystem of subsystems) {
        void pluginManager.runHook(`subsystem:${subsystem}:request-completed`, completedPayload);
      }
    };
    res.on("finish", () => finalize("finish"));
    res.on("close", () => finalize("close"));
    next();
  }

  return {
    compactHookText,
    sanitizeHookToken,
    summarizeHookValue,
    summarizeHookResponsePayload,
    summarizeHookRequestBody,
    requestTrackingMiddleware
  };
}
