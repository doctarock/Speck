import { createServer } from "node:http";
import { loadAppConfig } from "./config.js";
import { createGenesisSpeckHost } from "./genesis-host.js";
import { SpeckRuntime } from "./runtime/speck-runtime.js";
const config = loadAppConfig();
const runtime = new SpeckRuntime(config);
const recovery = await runtime.initialize();
const host = await createGenesisSpeckHost(runtime, config);
const server = createServer(host.app);
server.listen(config.port, config.host, () => {
    console.log(`[speck] listening on http://${config.host}:${config.port} (${recovery.recovered.length} worker(s) recovered)`);
});
let closing = false;
function shutdown(signal) {
    if (closing)
        return;
    closing = true;
    console.log(`[speck] ${signal}; shutting down`);
    server.close(async () => {
        await host.close();
        runtime.close();
        process.exitCode = 0;
    });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
//# sourceMappingURL=server.js.map