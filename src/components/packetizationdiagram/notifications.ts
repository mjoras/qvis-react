// Toasts of the packetization diagram (parity/packetization-diagram.md §6.1; texts verbatim, group "default").

/** More events than this show N-PZ1 and wait 200ms before rendering ("give time to show the warning"). */
export const LARGE_TRACE_EVENT_COUNT = 10000;

export const N_PZ1 = {
    group: "default",
    title: "Trace might take long to render",
    type: "warn",
    text: "Some large traces can take a long time to render. Please be patient.",
} as const;

export const N_PZ2 = {
    group: "default",
    title: "Trace could not be rendered",
    type: "error",
    text: "This trace could not be rendered. There could be an error or a previous file was still rendering.<br/>See the JavaScript devtools for more information.",
} as const;

export const N_PZ3 = {
    group: "default",
    title: "Trace data inconsistent",
    type: "warn",
    text: "Some frames could not be placed in the packetization diagram (not enough lower-layer bytes). See the JavaScript devtools for more information.",
} as const;
