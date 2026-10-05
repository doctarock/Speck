import crypto from "node:crypto";

export function hashRef(value = "") {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

export function normalizeTrustLevel(value, fallback = "unknown") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["unknown", "known", "trusted"].includes(normalized) ? normalized : fallback;
}

export function getTrustLevelRank(level) {
  const normalized = normalizeTrustLevel(level);
  if (normalized === "trusted") return 2;
  if (normalized === "known") return 1;
  return 0;
}

export function trustLevelLabel(level) {
  const normalized = normalizeTrustLevel(level);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function isTrustLevelAtLeast(level, minimum) {
  return getTrustLevelRank(level) >= getTrustLevelRank(minimum);
}

export function defaultAppTrustConfig() {
  return {
    emailCommandMinLevel: "trusted",
    voiceCommandMinLevel: "trusted",
    records: [],
    emailSources: [],
    phoneSources: [],
    voiceProfiles: []
  };
}

export function normalizeTrustAliasList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))]
    : [];
}

export function normalizePhoneNumber(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `${hasPlus ? "+" : ""}${digits}` : "";
}

export function normalizeTrustPhoneNumberList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(source.map(normalizePhoneNumber).filter(Boolean))];
}

export function normalizeTrustSignature(value) {
  return Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry)).slice(0, 64)
    : [];
}

export function normalizeVoiceTrustProfile(entry = {}, index = 0, options = {}) {
  const label = String(entry?.label || entry?.speakerLabel || `Voice profile ${index + 1}`).trim();
  const signature = normalizeTrustSignature(entry?.signature);
  const threshold = Math.max(0.45, Math.min(Number(entry?.threshold || 0.82), 0.99));
  const hash = typeof options.hashRef === "function" ? options.hashRef : hashRef;
  const now = Number(options.now || Date.now());
  return {
    id: String(entry?.id || entry?.sourceId || entry?.speakerId || `voice-profile-${hash(`${label}|${index}`)}`).trim(),
    label,
    trustLevel: normalizeTrustLevel(entry?.trustLevel, "known"),
    threshold,
    signature,
    notes: String(entry?.notes || "").trim(),
    capturedAt: Number(entry?.capturedAt || entry?.createdAt || (signature.length ? now : 0) || 0),
    updatedAt: Number(entry?.updatedAt || entry?.capturedAt || entry?.createdAt || (signature.length ? now : 0) || 0)
  };
}

export function normalizeEmailTrustSource(entry = {}, index = 0, options = {}) {
  const email = String(entry?.email || "").trim().toLowerCase();
  const label = String(entry?.label || email || `Email source ${index + 1}`).trim();
  const hash = typeof options.hashRef === "function" ? options.hashRef : hashRef;
  return {
    id: String(entry?.id || `email-source-${hash(`${email}|${label}|${index}`)}`).trim(),
    label,
    email,
    aliases: normalizeTrustAliasList(entry?.aliases),
    trustLevel: normalizeTrustLevel(entry?.trustLevel, "known"),
    notes: String(entry?.notes || "").trim()
  };
}

export function normalizePhoneTrustSource(entry = {}, index = 0, options = {}) {
  const phoneNumbers = normalizeTrustPhoneNumberList(entry?.phoneNumbers || entry?.phoneNumber || entry?.phone || entry?.mobile);
  const label = String(entry?.label || phoneNumbers[0] || `Phone source ${index + 1}`).trim();
  const hash = typeof options.hashRef === "function" ? options.hashRef : hashRef;
  return {
    id: String(entry?.id || `phone-source-${hash(`${phoneNumbers.join(",")}|${label}|${index}`)}`).trim(),
    label,
    phoneNumbers,
    aliases: normalizeTrustAliasList(entry?.aliases),
    trustLevel: normalizeTrustLevel(entry?.trustLevel, "known"),
    notes: String(entry?.notes || "").trim()
  };
}

export function normalizeCombinedTrustRecord(entry = {}, index = 0, options = {}) {
  const email = String(entry?.email || "").trim().toLowerCase();
  const fallbackLabel = email || `Trust record ${index + 1}`;
  const label = String(entry?.label || entry?.speakerLabel || fallbackLabel).trim() || fallbackLabel;
  const signature = normalizeTrustSignature(entry?.signature);
  const hash = typeof options.hashRef === "function" ? options.hashRef : hashRef;
  const now = Number(options.now || Date.now());
  return {
    id: String(entry?.id || entry?.sourceId || entry?.speakerId || `trust-record-${hash(`${email}|${label}|${index}`)}`).trim(),
    label,
    email,
    aliases: normalizeTrustAliasList(entry?.aliases),
    phoneNumbers: normalizeTrustPhoneNumberList(entry?.phoneNumbers || entry?.phoneNumber || entry?.phone || entry?.mobile),
    trustLevel: normalizeTrustLevel(entry?.trustLevel, "known"),
    threshold: Math.max(0.45, Math.min(Number(entry?.threshold || 0.82), 0.99)),
    signature,
    notes: String(entry?.notes || "").trim(),
    capturedAt: Number(entry?.capturedAt || entry?.createdAt || (signature.length ? now : 0) || 0),
    updatedAt: Number(entry?.updatedAt || entry?.capturedAt || entry?.createdAt || (signature.length ? now : 0) || 0)
  };
}

export function mergeTrustNotes(...values) {
  const seen = new Set();
  return values.map((value) => String(value || "").trim()).filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n\n");
}

export function hasCombinedTrustRecordData(entry = {}) {
  return Boolean(
    String(entry?.label || entry?.speakerLabel || "").trim()
    || String(entry?.email || "").trim()
    || normalizeTrustAliasList(entry?.aliases).length
    || normalizeTrustPhoneNumberList(entry?.phoneNumbers || entry?.phoneNumber || entry?.phone || entry?.mobile).length
    || String(entry?.notes || "").trim()
    || normalizeTrustSignature(entry?.signature).length
  );
}

export function findMatchingTrustRecordIndex(records = [], entry = {}) {
  const id = String(entry?.id || entry?.sourceId || entry?.speakerId || "").trim();
  const email = String(entry?.email || "").trim().toLowerCase();
  const label = String(entry?.label || entry?.speakerLabel || "").trim().toLowerCase();
  const phoneNumbers = normalizeTrustPhoneNumberList(entry?.phoneNumbers || entry?.phoneNumber || entry?.phone || entry?.mobile);
  return records.findIndex((record) => {
    const recordPhones = normalizeTrustPhoneNumberList(record?.phoneNumbers || record?.phoneNumber || record?.phone || record?.mobile);
    return (
      (id && String(record?.id || "").trim() === id)
      || (email && String(record?.email || "").trim().toLowerCase() === email)
      || (label && String(record?.label || "").trim().toLowerCase() === label)
      || (phoneNumbers.length && phoneNumbers.some((phone) => recordPhones.includes(phone)))
    );
  });
}

export function mergeTrustRecord(target = {}, incoming = {}, index = 0, options = {}) {
  const current = normalizeCombinedTrustRecord(target, index, options);
  const next = normalizeCombinedTrustRecord(incoming, index, options);
  return normalizeCombinedTrustRecord({
    id: current.id || next.id,
    label: current.label || next.label,
    email: current.email || next.email,
    aliases: [...new Set([...current.aliases, ...next.aliases])],
    phoneNumbers: [...new Set([...current.phoneNumbers, ...next.phoneNumbers])],
    trustLevel: getTrustLevelRank(next.trustLevel) > getTrustLevelRank(current.trustLevel) ? next.trustLevel : current.trustLevel,
    threshold: next.signature.length ? next.threshold : current.threshold,
    signature: next.signature.length ? next.signature : current.signature,
    notes: mergeTrustNotes(current.notes, next.notes),
    capturedAt: Math.max(Number(current.capturedAt || 0), Number(next.capturedAt || 0)),
    updatedAt: Math.max(Number(current.updatedAt || 0), Number(next.updatedAt || 0))
  }, index, options);
}

export function upsertTrustRecord(records = [], entry = {}, index = 0, options = {}) {
  const matchIndex = findMatchingTrustRecordIndex(records, entry);
  if (matchIndex >= 0) {
    records[matchIndex] = mergeTrustRecord(records[matchIndex], entry, matchIndex, options);
    return records;
  }
  records.push(normalizeCombinedTrustRecord(entry, index, options));
  return records;
}

export function trustRecordsToEmailSources(records = [], options = {}) {
  return records.filter((record) => String(record?.email || "").trim()).map((record, index) => normalizeEmailTrustSource(record, index, options));
}

export function trustRecordsToPhoneSources(records = [], options = {}) {
  return records.filter((record) => normalizeTrustPhoneNumberList(record?.phoneNumbers).length).map((record, index) => normalizePhoneTrustSource(record, index, options));
}

export function trustRecordsToVoiceProfiles(records = [], options = {}) {
  return records.filter((record) => normalizeTrustSignature(record?.signature).length).map((record, index) => normalizeVoiceTrustProfile(record, index, options));
}

export function normalizeAppTrustConfig(input = {}, options = {}) {
  const trust = input && typeof input === "object" ? input : {};
  const records = [];
  const voiceProfiles = Array.isArray(options?.voiceProfiles)
    ? options.voiceProfiles
    : (Array.isArray(trust.voiceProfiles) ? trust.voiceProfiles : []);
  if (Array.isArray(trust.records)) {
    trust.records.filter(hasCombinedTrustRecordData).forEach((entry, index) => upsertTrustRecord(records, entry, index, options));
  }
  if (Array.isArray(trust.emailSources)) {
    trust.emailSources.forEach((entry) => {
      const normalized = normalizeEmailTrustSource(entry, records.length, options);
      if (normalized.email) upsertTrustRecord(records, normalized, records.length, options);
    });
  }
  if (Array.isArray(trust.phoneSources)) {
    trust.phoneSources.forEach((entry) => {
      const normalized = normalizePhoneTrustSource(entry, records.length, options);
      if (normalized.phoneNumbers.length) upsertTrustRecord(records, normalized, records.length, options);
    });
  }
  voiceProfiles.forEach((entry) => {
    const normalized = normalizeVoiceTrustProfile(entry, records.length, options);
    if (normalized.label || normalized.signature.length) upsertTrustRecord(records, normalized, records.length, options);
  });
  return {
    emailCommandMinLevel: normalizeTrustLevel(trust.emailCommandMinLevel, "trusted"),
    voiceCommandMinLevel: normalizeTrustLevel(trust.voiceCommandMinLevel, "trusted"),
    records: records.map((record, index) => normalizeCombinedTrustRecord(record, index, options)),
    emailSources: trustRecordsToEmailSources(records, options),
    phoneSources: trustRecordsToPhoneSources(records, options),
    voiceProfiles: trustRecordsToVoiceProfiles(records, options)
  };
}

export function normalizeSourceIdentityRecord(value = {}, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const preserveTrustLevel = options?.preserveTrustLevel === true;
  const kind = String(source.kind || "").trim().toLowerCase();
  if (!kind) return null;
  const normalized = {
    kind,
    trustLevel: preserveTrustLevel ? normalizeTrustLevel(source.trustLevel, "unknown") : "unknown"
  };
  if (kind === "voice") {
    normalized.speakerId = String(source.speakerId || source.sourceId || source.id || "").trim();
    normalized.speakerLabel = String(source.speakerLabel || source.label || "Unknown speaker").trim();
    normalized.label = normalized.speakerLabel;
    normalized.similarity = Number.isFinite(Number(source.similarity)) ? Number(source.similarity) : 0;
    normalized.threshold = Number.isFinite(Number(source.threshold)) ? Number(source.threshold) : 0;
    normalized.matchedProfileId = String(source.matchedProfileId || source.speakerId || source.sourceId || "").trim();
    normalized.matchedBy = String(source.matchedBy || "").trim();
    return normalized;
  }
  if (kind === "email") {
    normalized.email = String(source.email || "").trim().toLowerCase();
    normalized.label = String(source.label || source.email || "Email source").trim();
    normalized.sourceId = String(source.sourceId || "").trim();
    normalized.matchedBy = String(source.matchedBy || "").trim();
    if (source.command) {
      const compact = typeof options.compactTaskText === "function"
        ? options.compactTaskText
        : (text = "", max = 400) => String(text || "").trim().slice(0, max);
      normalized.command = {
        detected: source.command.detected === true,
        action: String(source.command.action || "").trim(),
        text: compact(String(source.command.text || "").trim(), 400),
        reason: compact(String(source.command.reason || "").trim(), 220)
      };
    }
    return normalized;
  }
  if (kind === "phone") {
    normalized.phoneNumber = normalizePhoneNumber(source.phoneNumber || source.phone || source.mobile || "");
    normalized.label = String(source.label || source.callerName || source.phoneNumber || "Unknown caller").trim();
    normalized.sourceId = String(source.sourceId || "").trim();
    normalized.matchedBy = String(source.matchedBy || "").trim();
    normalized.notes = String(source.notes || "").trim();
    return normalized;
  }
  normalized.label = String(source.label || kind).trim();
  return normalized;
}

export function describeSourceTrust(sourceIdentity = {}) {
  const kind = String(sourceIdentity?.kind || "source").trim();
  const label = String(sourceIdentity?.label || sourceIdentity?.email || sourceIdentity?.speakerLabel || kind).trim() || kind;
  return `${label} (${trustLevelLabel(sourceIdentity?.trustLevel)})`;
}
