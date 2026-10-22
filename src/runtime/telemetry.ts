export interface TelemetrySnapshot {
  startedAt: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export class Telemetry {
  private readonly startedAt = new Date().toISOString();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  snapshot(): TelemetrySnapshot {
    return {
      startedAt: this.startedAt,
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges)
    };
  }
}
