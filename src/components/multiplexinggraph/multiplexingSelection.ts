// Selection helpers of the multiplexing configurator (qvis MultiplexingGraphConfigurator.vue:80-107), kept out of the
// component module so they can be unit-tested (and for react-refresh).

import type { QlogConnection } from "@/model/QlogConnection";

/**
 * qvis `allowSelectAll` (M26, app-shell Q20, PRESERVE): a substring check on the whole URL, e.g. add
 * `?multimultiplexing=true`. Also true on any `localhost` or `:8080` URL.
 */
export function allowSelectAllFor(href: string): boolean {
    return href.indexOf(":8080") >= 0 || href.indexOf("localhost") >= 0 || href.indexOf("multimultiplexing") >= 0;
}

/**
 * Every trace of every loaded file, stable-sorted on file name (code-unit order `<`, not localeCompare; ties keep load
 * order; M25). Otherwise they're in whatever order they were loaded, which seems wholly indeterministic.
 */
export function allConnectionsSortedByFilename(
    groups: readonly { getConnections(): readonly QlogConnection[] }[],
): QlogConnection[] {
    const conns: QlogConnection[] = [];
    for (const group of groups) {
        conns.push(...group.getConnections());
    }
    return conns.sort((c1, c2) => {
        const a = c1.parent.filename;
        const b = c2.parent.filename;
        return a < b ? -1 : a > b ? 1 : 0;
    });
}
