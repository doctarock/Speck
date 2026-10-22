export const BACKGROUND_JOB_KINDS = [
  "consolidation", "pattern-synthesis", "procedure-compilation", "embedding-generation",
  "calibration-maintenance", "association-maintenance"
] as const;
export type BackgroundJobKind = (typeof BACKGROUND_JOB_KINDS)[number];

export interface BackgroundJobResult {
  kind: BackgroundJobKind;
  workerId: string;
  examined: number;
  changed: number;
  createdIds: string[];
}

export interface BackgroundSliceResult {
  status: "completed" | "deferred" | "busy" | "disabled";
  processed: number;
  remaining: number;
  elapsedMs: number;
  reason: string | null;
  jobs: BackgroundJobResult[];
}
