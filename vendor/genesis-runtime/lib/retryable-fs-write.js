const RETRYABLE_FS_WRITE_ERROR_CODES = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "EPERM",
  "EACCES",
  "UNKNOWN"
]);

export function isRetryableFsWriteError(error) {
  return RETRYABLE_FS_WRITE_ERROR_CODES.has(String(error?.code || "").trim().toUpperCase());
}

export function waitForFsWriteRetry(attempt, { baseMs = 50, capMs = 2000 } = {}) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(capMs, baseMs * Math.pow(2, attempt)));
  });
}
