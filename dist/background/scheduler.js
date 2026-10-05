import { performance } from "node:perf_hooks";
export class BackgroundScheduler {
    foregroundDepth = 0;
    running = false;
    get foregroundActive() { return this.foregroundDepth > 0; }
    get backgroundActive() { return this.running; }
    beginForeground() {
        this.foregroundDepth += 1;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.foregroundDepth = Math.max(0, this.foregroundDepth - 1);
        };
    }
    async runSlice(tasks, options) {
        if (!options.enabled)
            return empty("disabled", tasks.length, "background cognition disabled");
        if (this.running)
            return empty("busy", tasks.length, "background slice already running");
        if (this.foregroundActive)
            return empty("deferred", tasks.length, "foreground work active");
        this.running = true;
        const started = performance.now();
        const jobs = [];
        let reason = null;
        try {
            for (const task of tasks) {
                if (jobs.length >= options.maximumOperations) {
                    reason = "operation budget exhausted";
                    break;
                }
                if (performance.now() - started >= options.timeBudgetMs) {
                    reason = "time budget exhausted";
                    break;
                }
                // Yield before every mutation. Incoming foreground handlers can acquire
                // a lease and will be observed before the next background operation.
                await immediate();
                if (this.foregroundActive) {
                    reason = "foreground work arrived";
                    break;
                }
                jobs.push(await task.run());
            }
        }
        finally {
            this.running = false;
        }
        const remaining = Math.max(0, tasks.length - jobs.length);
        return {
            status: remaining > 0 ? "deferred" : "completed",
            processed: jobs.length,
            remaining,
            elapsedMs: performance.now() - started,
            reason,
            jobs
        };
    }
}
function empty(status, remaining, reason) {
    return { status, processed: 0, remaining, elapsedMs: 0, reason, jobs: [] };
}
function immediate() {
    return new Promise((resolve) => setImmediate(resolve));
}
//# sourceMappingURL=scheduler.js.map