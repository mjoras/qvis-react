// Non-modal diagnostics (main-schema digest section 22 conventions): collected per file, deduplicated by `code`.
// The first occurrence fixes `level`, `message`, `traceIndex` and `sample`; later occurrences only increase
// `count` and add up to MAX_SAMPLES distinct `samples`.

export type DiagnosticLevel = "error" | "warning" | "info";

export interface Diagnostic {
    level: DiagnosticLevel;
    /** Stable identifier, e.g. "trace.reordered". Tests and toast builders key on it. */
    code: string;
    /** Generic, human-readable description (one line, no HTML). */
    message: string;
    /** Number of occurrences. */
    count: number;
    /** Index in `traces` of the first occurrence, when it belongs to a trace. */
    traceIndex?: number;
    /** Example value of the first occurrence (e.g. an event name or a record excerpt). */
    sample?: unknown;
    /** Up to {@link MAX_SAMPLES} distinct example values, first-seen order. */
    samples?: unknown[];
}

export const MAX_SAMPLES = 5;

export interface DiagnosticOptions {
    traceIndex?: number;
    sample?: unknown;
    /** Number of occurrences this call represents (default 1). */
    count?: number;
}

const LEVEL_RANK: Record<DiagnosticLevel, number> = { info: 0, warning: 1, error: 2 };

export class DiagnosticCollector {
    private readonly list: Diagnostic[] = [];
    private readonly byCode = new Map<string, Diagnostic>();

    add(level: DiagnosticLevel, code: string, message: string, opts?: DiagnosticOptions): Diagnostic {
        const count = opts?.count ?? 1;
        let d = this.byCode.get(code);
        if (d === undefined) {
            d = { level, code, message, count };
            if (opts?.traceIndex !== undefined) d.traceIndex = opts.traceIndex;
            if (opts?.sample !== undefined) {
                d.sample = opts.sample;
                d.samples = [opts.sample];
            }
            this.byCode.set(code, d);
            this.list.push(d);
            return d;
        }
        d.count += count;
        if (LEVEL_RANK[level] > LEVEL_RANK[d.level]) d.level = level;
        if (opts?.sample !== undefined) addSample(d, opts.sample);
        return d;
    }

    error(code: string, message: string, opts?: DiagnosticOptions): Diagnostic {
        return this.add("error", code, message, opts);
    }
    warn(code: string, message: string, opts?: DiagnosticOptions): Diagnostic {
        return this.add("warning", code, message, opts);
    }
    info(code: string, message: string, opts?: DiagnosticOptions): Diagnostic {
        return this.add("info", code, message, opts);
    }

    /** Merges already collected diagnostics (e.g. parse-level ones into the model's list). */
    merge(diagnostics: readonly Diagnostic[] | undefined): void {
        if (!diagnostics) return;
        for (const src of diagnostics) {
            const existing = this.byCode.get(src.code);
            if (existing === undefined) {
                const copy: Diagnostic = { ...src };
                if (src.samples) copy.samples = src.samples.slice();
                this.byCode.set(copy.code, copy);
                this.list.push(copy);
                continue;
            }
            existing.count += src.count;
            if (LEVEL_RANK[src.level] > LEVEL_RANK[existing.level]) existing.level = src.level;
            for (const s of src.samples ?? (src.sample !== undefined ? [src.sample] : [])) addSample(existing, s);
        }
    }

    has(code: string): boolean {
        return this.byCode.has(code);
    }

    get(code: string): Diagnostic | undefined {
        return this.byCode.get(code);
    }

    /** All diagnostics in first-occurrence order (the live objects). */
    toArray(): Diagnostic[] {
        return this.list.slice();
    }

    get size(): number {
        return this.list.length;
    }
}

function addSample(d: Diagnostic, sample: unknown): void {
    if (!d.samples) d.samples = [];
    if (d.sample === undefined) d.sample = sample;
    if (d.samples.length >= MAX_SAMPLES) return;
    if (typeof sample !== "object" || sample === null) {
        if (d.samples.includes(sample)) return;
    }
    d.samples.push(sample);
}

/** Formats a diagnostic for the console: `[code] message (3x)`. */
export function formatDiagnostic(d: Diagnostic): string {
    return "[" + d.code + "] " + d.message + (d.count > 1 ? " (" + d.count + "x)" : "");
}
