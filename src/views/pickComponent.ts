// Resolves a page component from its module namespace, accepting either a default export or a named export.
// The containers behind the views are written by other work packages in parallel (ARCHITECTURE §3.5); this keeps the
// thin view wrappers independent of whichever export style a package picks.

import type { ComponentType } from "react";

export function pickComponent(mod: object, exportName: string): ComponentType {
    const m = mod as Record<string, unknown>;
    const candidate = m["default"] ?? m[exportName];
    if (typeof candidate === "function" || (typeof candidate === "object" && candidate !== null)) {
        return candidate as ComponentType;
    }
    const Missing = () => null;
    Missing.displayName = "Missing(" + exportName + ")";
    console.error("qvis: module does not export a component named default or " + exportName);
    return Missing;
}
