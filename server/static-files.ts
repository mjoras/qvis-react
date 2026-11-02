// Static file serving for the local server: maps a request path onto the build output (dist/) without letting it
// escape the root on any platform (encoded separators, backslashes, drive letters, Windows device names and
// alternate data streams are all refused).

import { createReadStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
};

export function contentTypeFor(file: string): string {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

// CON, NUL, COM1, ... (with any extension) name devices on Windows, in every directory
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * The file a URL path names inside `root`, or undefined when the path is not a plain relative path. Each segment is
 * percent-decoded on its own; a decoded segment containing a separator, a colon, NUL, `.`/`..`, a trailing dot or
 * space (Windows strips those) or a Windows device name is refused.
 */
export function resolveStaticPath(root: string, pathname: string): string | undefined {
    if (!pathname.startsWith("/")) return undefined;
    const segments: string[] = [];
    for (const raw of pathname.slice(1).split("/")) {
        let segment: string;
        try {
            segment = decodeURIComponent(raw);
        } catch {
            return undefined;
        }
        if (segment === "") continue;
        if (segment === "." || segment === "..") return undefined;
        if (/[/\\:\0]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_DEVICE.test(segment)) return undefined;
        segments.push(segment);
    }
    const full = path.resolve(root, ...segments);
    return isInside(root, full) ? full : undefined;
}

function isInside(root: string, full: string): boolean {
    const rel = path.relative(root, full);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface StaticResult {
    file: string;
    size: number;
    mtimeMs: number;
}

/**
 * Finds the regular file to serve for `pathname` (`/` and `dir/` serve their index.html). `root` must already be a
 * native realpath (fs.realpathSync.native), the same implementation used here, so that both sides are spelled
 * alike (8.3 names, subst/mapped drives on Windows, on-disk case on macOS).
 *
 * The file's real path must be exactly the requested path: a different case (case-insensitive file systems), a
 * Windows short name or a symlink anywhere on the way is not found, as on Vercel and on Linux.
 */
export async function findStaticFile(root: string, pathname: string): Promise<StaticResult | undefined> {
    const resolved = resolveStaticPath(root, pathname);
    if (resolved === undefined) return undefined;
    try {
        let file = resolved;
        let stat = await fs.stat(file);
        if (stat.isDirectory()) {
            // Vercel serves dir/index.html for dir/ (and index.json for some directories, which the app never uses)
            if (!pathname.endsWith("/")) return undefined;
            file = path.join(file, "index.html");
            stat = await fs.stat(file);
        }
        if (!stat.isFile()) return undefined;
        const real = await fs.realpath(file);
        if (path.relative(root, real) !== path.relative(root, file)) return undefined;
        return { file: real, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
        return undefined;
    }
}

/** RFC 9110 If-None-Match with weak comparison: `*`, or a comma-separated list of entity tags. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
    if (ifNoneMatch === undefined) return false;
    if (ifNoneMatch.trim() === "*") return true;
    const opaque = (t: string) => t.trim().replace(/^W\//, "");
    return ifNoneMatch.split(",").some((t) => opaque(t) === opaque(etag));
}

/** Streams a file found by findStaticFile, with ETag / If-None-Match revalidation. */
export function sendStaticFile(
    req: IncomingMessage,
    res: ServerResponse,
    found: StaticResult,
    headers: Record<string, string>,
): void {
    const etag = `W/"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.setHeader("ETag", etag);
    if (etagMatches(req.headers["if-none-match"], etag)) {
        res.statusCode = 304;
        res.end();
        return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(found.file));
    res.setHeader("Content-Length", String(found.size));
    if (req.method === "HEAD") {
        res.end();
        return;
    }
    const stream = createReadStream(found.file);
    stream.once("error", (err) => {
        console.error("qvis local server: cannot read", found.file, err.message);
        res.destroy(err);
    });
    res.once("close", () => stream.destroy());
    stream.pipe(res);
}
