// Shared helpers for the per-tool "select default" logic (parity/app-shell.md §2.5.7, Q12).

interface GroupLike<C> {
    getConnections(): readonly C[];
}

/**
 * The connection a tool auto-selects when it has no selection: the first trace of the first loaded file that
 * HAS a trace (Q12 fix: files with zero connections are skipped instead of crashing). undefined if none.
 */
export function firstAvailableConnection<C>(groups: readonly GroupLike<C>[]): C | undefined {
    for (const g of groups) {
        const conns = g.getConnections();
        if (conns.length > 0) {
            return conns[0];
        }
    }
    return undefined;
}
