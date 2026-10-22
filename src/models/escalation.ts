import type { ModelEscalationConfig } from "../config.js";
import type { CalibrationProfile } from "../metacognition/types.js";
import type { ModelProcessorSnapshot, ModelTier } from "./types.js";

export interface EscalationRoute {
  processor: ModelProcessorSnapshot;
  fromTier: number;
  toTier: ModelTier;
  reliability: number;
  reason: string;
}

export function routeEscalation(input: {
  processors: readonly ModelProcessorSnapshot[];
  fromTier: number;
  specialty?: string;
  minimumContextSize?: number;
  calibration?: Record<string, CalibrationProfile>;
  config: ModelEscalationConfig;
}): EscalationRoute {
  const specialty = input.specialty?.trim().toLowerCase();
  const candidates = input.processors.filter((processor) => processor.enabled && processor.available
    && processor.tier > input.fromTier
    && processor.tier <= input.config.maximumTier
    && processor.contextSize >= (input.minimumContextSize ?? 0));
  candidates.sort((left, right) =>
    (specialty ? Number(right.specialties.includes(specialty)) - Number(left.specialties.includes(specialty)) : 0)
    || left.tier - right.tier
    || effectiveReliability(right, input.calibration) - effectiveReliability(left, input.calibration)
    || modelCost(left) - modelCost(right)
    || left.id.localeCompare(right.id)
  );
  const processor = candidates[0];
  if (!processor) throw new TypeError("No available higher-tier processor satisfies the escalation request");
  return {
    processor,
    fromTier: input.fromTier,
    toTier: processor.tier,
    reliability: effectiveReliability(processor, input.calibration),
    reason: `smallest available tier above ${input.fromTier}`
  };
}

export class TierScheduler {
  private readonly inFlight = new Map<number, number>();

  constructor(private readonly capacities: Readonly<Record<number, number>>) {}

  tryAcquire(tier: number): (() => void) | null {
    const capacity = Math.max(1, Math.floor(this.capacities[tier] ?? 1));
    const current = this.inFlight.get(tier) ?? 0;
    if (current >= capacity) return null;
    this.inFlight.set(tier, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(tier, Math.max(0, (this.inFlight.get(tier) ?? 1) - 1));
    };
  }

  snapshot(): Array<{ tier: number; capacity: number; inFlight: number; available: number }> {
    return Object.entries(this.capacities).map(([tierValue, capacityValue]) => {
      const tier = Number(tierValue);
      const capacity = Math.max(1, Math.floor(capacityValue));
      const inFlight = this.inFlight.get(tier) ?? 0;
      return { tier, capacity, inFlight, available: Math.max(0, capacity - inFlight) };
    }).sort((a, b) => a.tier - b.tier);
  }
}

function effectiveReliability(processor: ModelProcessorSnapshot, profiles: Record<string, CalibrationProfile> | undefined): number {
  return profiles?.[processor.id]?.reliability ?? processor.historicalReliability;
}

function modelCost(processor: ModelProcessorSnapshot): number {
  return (processor.costPerMillionInputTokens ?? 0) + (processor.costPerMillionOutputTokens ?? 0);
}
