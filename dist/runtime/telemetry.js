export class Telemetry {
    startedAt = new Date().toISOString();
    counters = new Map();
    gauges = new Map();
    increment(name, amount = 1) {
        this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
    }
    gauge(name, value) {
        this.gauges.set(name, value);
    }
    snapshot() {
        return {
            startedAt: this.startedAt,
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges)
        };
    }
}
//# sourceMappingURL=telemetry.js.map