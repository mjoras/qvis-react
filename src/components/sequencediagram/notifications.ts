// Toasts of the sequence diagram (parity/sequence-diagram.md §6.1, verbatim).

/** SN1 is shown before rendering when the first trace has more events than this. */
export const LARGE_TRACE_EVENT_COUNT = 10000;

export const SN1_LARGE_TRACE = {
    group: "default",
    title: "Trace might take long to render",
    type: "warn",
    text: "Some large traces can take a long time to render. Please be patient.",
} as const;

export const SN2_NOT_RENDERED = {
    group: "default",
    title: "Trace could not be rendered",
    type: "error",
    text: "This trace could not be rendered. There could be an error or a previous file was still rendering.<br/>See the JavaScript devtools for more information.",
} as const;
