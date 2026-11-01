// The danger / warning alert pair every tool configurator shows while no file is loaded
// (parity/app-shell.md §2.5.7, §6.2). Renders nothing once at least one file exists.

import { useConnectionStore } from "@/store/connectionStore";

export default function NoTraceAlerts() {
    const groupCount = useConnectionStore((s) => s.groups.length);
    const outstanding = useConnectionStore((s) => s.outstandingRequestCount);

    if (groupCount > 0) {
        return null;
    }
    if (outstanding === 0) {
        return (
            <div role="alert" className="alert alert-danger">
                Please load a trace file to visualize it
            </div>
        );
    }
    return (
        <div role="alert" className="alert alert-warning">
            Loading files...
        </div>
    );
}

export { NoTraceAlerts };
