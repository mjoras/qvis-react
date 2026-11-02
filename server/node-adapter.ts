// Runs a Web-standard `(Request) => Response` handler (the shape of the Vercel Function in api/loadfiles.ts) on a
// node:http request. Used by the local server (server/local-server.ts) and by the Vite dev/preview servers
// (server/vite-plugin.ts), so all three run the same proxy code as the Vercel deployment.
//
// Self-contained (node: imports only), so vite.config.ts can import it directly.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

export type WebHandler = (request: Request) => Response | Promise<Response>;

/**
 * Headers a reverse proxy sets about the original request. On Vercel the edge sets them; here this server is the
 * edge, so any such header came from the client, and api/loadfiles.ts would trust a forged X-Forwarded-Host as one
 * of its own origins (its cross-site check). They are dropped.
 */
const FORWARDING_HEADERS: ReadonlySet<string> = new Set([
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
]);

/** The function's paths: Vercel routes /api/loadfiles and /api/loadfiles/ to api/loadfiles.ts. */
export const PROXY_ROUTE = "/api/loadfiles";
export function isProxyPath(pathname: string): boolean {
    return pathname === PROXY_ROUTE || pathname === PROXY_ROUTE + "/";
}

/** Methods the function exports (GET, HEAD, OPTIONS); others get 405 before a Request is built (TRACE cannot be). */
export function isProxyMethod(method: string | undefined): boolean {
    return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function proxyMethodNotAllowed(res: ServerResponse): void {
    res.writeHead(405, {
        Allow: "GET, HEAD, OPTIONS",
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify({ error: "Only GET is supported by the qvis proxy" }));
}

/**
 * Builds a Web `Request` from a node:http request. `origin` is the server's own origin (scheme + authority) used to
 * make `req.url` absolute. Request bodies are not forwarded: the proxy only answers GET, HEAD and OPTIONS.
 */
export function toWebRequest(req: IncomingMessage, origin: string, signal?: AbortSignal): Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || name.startsWith(":") || FORWARDING_HEADERS.has(name)) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(name, v);
        else headers.set(name, value);
    }
    // concatenated, not resolved: a request target such as `//other.host/x` must stay a path of this server
    return new Request(new URL(origin + (req.url ?? "/")), { method: req.method ?? "GET", headers, signal });
}

/** Writes a Web `Response` to a node:http response, streaming the body; HEAD responses get headers only. */
export async function sendWebResponse(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
    if (res.destroyed || res.writableEnded) {
        // the client went away while the handler was working: release the upstream body
        await response.body?.cancel();
        return;
    }
    res.statusCode = response.status;
    for (const [name, value] of response.headers) {
        if (name === "set-cookie") continue; // the proxy never sets cookies
        res.setHeader(name, value);
    }
    if (response.body === null || req.method === "HEAD") {
        await response.body?.cancel();
        res.end();
        return;
    }
    const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
    await new Promise<void>((resolve) => {
        // the client went away: stop reading the upstream body
        res.once("close", () => {
            if (!res.writableFinished) body.destroy();
            resolve();
        });
        body.once("error", (err) => {
            // headers are already sent; all we can do is cut the connection so the client sees a failed download
            console.error("qvis local server: response stream failed:", err.message);
            res.destroy(err);
        });
        body.pipe(res);
    });
}

/** Runs `handler` for one node:http request and writes its response (500 JSON if the handler throws). */
export async function runWebHandler(
    handler: WebHandler,
    req: IncomingMessage,
    res: ServerResponse,
    origin: string,
): Promise<void> {
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    let response: Response;
    try {
        response = await handler(toWebRequest(req, origin, controller.signal));
    } catch (e) {
        console.error("qvis local server: handler failed:", e);
        response = new Response(JSON.stringify({ error: "Internal error in the qvis proxy" }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
    }
    await sendWebResponse(req, res, response);
}
