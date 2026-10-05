import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function writeBenchmarkReport(filePath, report) {
    await atomicWrite(filePath, `${JSON.stringify(report, null, 2)}\n`);
}
export async function writeBenchmarkRunsJsonl(filePath, report) {
    await atomicWrite(filePath, `${report.runs.map((run) => JSON.stringify(run)).join("\n")}\n`);
}
async function atomicWrite(filePath, content) {
    const resolved = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const temporary = `${resolved}.tmp-${randomUUID()}`;
    try {
        await fs.writeFile(temporary, content, "utf8");
        await fs.rename(temporary, resolved);
    }
    catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
    }
}
//# sourceMappingURL=reporter.js.map