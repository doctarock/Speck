// The workspace's files: listing, and resolving paths safely inside a root.
import fs from "node:fs/promises";
import path from "node:path";
export async function collectWorkspaceEntries(root) {
    const entries = [];
    const queue = [{ absolute: root, relative: "", depth: 0 }];
    while (queue.length > 0 && entries.length < 180) {
        const current = queue.shift();
        const children = await fs.readdir(current.absolute, { withFileTypes: true }).catch(() => []);
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
            if (entries.length >= 180)
                break;
            const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
            const absolute = path.join(current.absolute, child.name);
            if (child.isSymbolicLink())
                continue;
            if (child.isDirectory()) {
                if (current.depth < 5 && !child.name.startsWith(".")) {
                    queue.push({ absolute, relative, depth: current.depth + 1 });
                }
                continue;
            }
            if (!child.isFile() || child.name === ".DS_Store")
                continue;
            const stat = await fs.stat(absolute).catch(() => null);
            if (!stat)
                continue;
            const extension = path.extname(child.name).slice(1).toLowerCase();
            entries.push({
                path: relative.replaceAll("\\", "/"),
                name: child.name,
                extension,
                kind: workspaceEntryKind(child.name, extension),
                size: stat.size,
                modifiedAt: stat.mtimeMs
            });
        }
    }
    return entries.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
}
export function workspaceEntryKind(name, extension) {
    if (["md", "mdx", "txt", "text", "pdf", "doc", "docx", "rtf"].includes(extension))
        return "document";
    if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "html", "sql", "sh", "ps1"].includes(extension))
        return "code";
    if (["json", "yaml", "yml", "toml", "ini", "env"].includes(extension) || /config/i.test(name))
        return "configuration";
    if (["csv", "sqlite", "db", "jsonl"].includes(extension))
        return "data";
    if (["png", "jpg", "jpeg", "gif", "svg", "webp", "glb", "gltf", "mp3", "wav"].includes(extension))
        return "asset";
    return "file";
}
export async function resolveExistingWorkspaceFile(root, requestedPath) {
    const normalized = requestedPath.replaceAll("\\", "/");
    if (path.posix.isAbsolute(normalized))
        throw new TypeError("file must be relative to its scope");
    const rootPath = await fs.realpath(root);
    const targetPath = await fs.realpath(path.resolve(rootPath, normalized));
    const relative = path.relative(rootPath, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new TypeError("file must remain inside its scope");
    }
    const stat = await fs.stat(targetPath);
    if (!stat.isFile())
        throw new TypeError("file must identify a regular file");
    return targetPath;
}
export async function resolveNewWorkspaceFile(root, requestedPath) {
    const normalized = requestedPath.replaceAll("\\", "/").trim();
    if (!normalized || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\0")) {
        throw new TypeError("file name must not contain a path");
    }
    const rootPath = await fs.realpath(root);
    const targetPath = path.resolve(rootPath, normalized);
    const relative = path.relative(rootPath, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new TypeError("file must remain inside the workspace inbox");
    }
    return targetPath;
}
export function fileErrorStatus(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? 404 : 400;
}
//# sourceMappingURL=files.js.map