// Trace / file labels used by the shared selector (parity/app-shell.md §2.5.4, §2.5.5).
// The formulas live once in src/model/labels.ts (core package); this module re-exports the ones the shell uses so
// shell code and tests have a stable import path.

export {
    COMBINED_CONNECTION_PREFIX,
    combinedConnectionOptionLabel as combinedConnectionLabel,
    combinedHeaderLabel,
    connectionLabel,
    groupOptionLabel,
    type LabelConnection,
    type LabelConnectionWithParent,
    type LabelGroup,
    type LabelVantagePoint,
} from "@/model/labels";
