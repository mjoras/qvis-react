// Thin route wrapper for #/debug (qvis views/VUEDebug.vue; parity/app-shell.md §2.7, §8.8).

import DebugPage from "@/components/debug/DebugPage";

export default function DebugView() {
    return <DebugPage />;
}
