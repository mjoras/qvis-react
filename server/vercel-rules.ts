// Applies vercel.json `rewrites` and `headers` outside Vercel, so the local server sends the same
// Content-Security-Policy, cache and security headers as the deployment. vercel.json stays the single source of truth.
//
// Only the subset of Vercel's path-to-regexp `source` syntax that vercel.json uses is implemented: literal characters
// plus parenthesized regular-expression groups such as `(.*)` or `((?!api/|loadfiles).*)`. Anything else (`:name`
// parameters, modifiers, `has`/`missing` conditions) throws at startup, so a vercel.json change the local server does
// not understand fails loudly instead of being ignored.

export interface HeaderRule {
    source: string;
    headers: { key: string; value: string }[];
}

export interface RewriteRule {
    source: string;
    destination: string;
}

export interface VercelRules {
    /** First matching rewrite destination for a request path, or the path itself. */
    rewrite(pathname: string): string;
    /** Headers of every matching rule, in file order (a later rule overrides an earlier one for the same name). */
    headersFor(pathname: string): Record<string, string>;
}

/** Converts a vercel.json `source` (literal path plus regex groups) to an anchored RegExp. */
export function sourceToRegExp(source: string): RegExp {
    if (!source.startsWith("/")) throw unsupported(source, "it must start with /");
    let out = "^";
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === "(") {
            let depth = 0;
            let j = i;
            for (; j < source.length; j++) {
                const c = source[j];
                if (c === "\\") {
                    j++;
                    continue;
                }
                if (c === "(") depth++;
                else if (c === ")" && --depth === 0) break;
            }
            if (depth !== 0) throw unsupported(source, "unbalanced parentheses");
            out += source.slice(i, j + 1);
            i = j + 1;
            const next = source[i];
            if (next === "?" || next === "*" || next === "+") throw unsupported(source, "group modifiers");
            continue;
        }
        if (":*?+{}".includes(ch)) throw unsupported(source, "named parameters and modifiers");
        out += /[.^$|[\]\\]/.test(ch) ? "\\" + ch : ch;
        i++;
    }
    return new RegExp(out + "$");
}

function unsupported(source: string, why: string): Error {
    return new Error(
        `vercel.json source "${source}" is not supported by the local server (${why}); ` +
            "server/vercel-rules.ts implements literal paths and (regex) groups only",
    );
}

export function compileVercelRules(config: unknown): VercelRules {
    const c = (config ?? {}) as { rewrites?: unknown; headers?: unknown };
    const rewrites = asArray<RewriteRule>(c.rewrites, "rewrites").map((r) => {
        if (typeof r.source !== "string" || typeof r.destination !== "string" || "has" in r || "missing" in r) {
            throw new Error("vercel.json rewrite not supported by the local server: " + JSON.stringify(r));
        }
        if (!/^\/[^():*?+{}]*$/.test(r.destination)) {
            throw new Error("vercel.json rewrite destination must be a literal path: " + r.destination);
        }
        return { re: sourceToRegExp(r.source), destination: r.destination };
    });
    const headers = asArray<HeaderRule>(c.headers, "headers").map((h) => {
        if (typeof h.source !== "string" || !Array.isArray(h.headers) || "has" in h || "missing" in h) {
            throw new Error("vercel.json header rule not supported by the local server: " + JSON.stringify(h));
        }
        return { re: sourceToRegExp(h.source), headers: h.headers };
    });
    return {
        rewrite(pathname) {
            return rewrites.find((r) => r.re.test(pathname))?.destination ?? pathname;
        },
        headersFor(pathname) {
            const out: Record<string, string> = {};
            for (const rule of headers) {
                if (!rule.re.test(pathname)) continue;
                for (const { key, value } of rule.headers) {
                    for (const existing of Object.keys(out)) {
                        if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
                    }
                    out[key] = value;
                }
            }
            return out;
        },
    };
}

function asArray<T>(v: unknown, name: string): T[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`vercel.json "${name}" must be an array`);
    return v as T[];
}
