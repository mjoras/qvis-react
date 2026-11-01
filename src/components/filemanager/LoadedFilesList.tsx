// "List of loaded files" (file-loading spec §2.9): one row per group with link/filename, shorthand, Remove and
// Download. FIX Q3: only http(s) URLs become links, opened in a new tab.

import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { safeHref } from "./links";

export interface LoadedFilesListProps {
    groups: readonly QlogConnectionGroup[];
    onRemove(group: QlogConnectionGroup): void;
    onDownload(group: QlogConnectionGroup): void;
}

const keys = new WeakMap<object, number>();
let nextKey = 1;

function keyFor(group: object): number {
    let k = keys.get(group);
    if (k === undefined) {
        k = nextKey++;
        keys.set(group, k);
    }
    return k;
}

export default function LoadedFilesList({ groups, onRemove, onDownload }: LoadedFilesListProps) {
    return (
        <div className="row fileOptionContainer" style={{ padding: "50px 0" }}>
            <div className="col">
                <div className="row">
                    <div className="col-1 col-md-auto">
                        <h3>List of loaded files</h3>
                    </div>
                </div>
                <div className="row">
                    <div id="loadedGroupsContainer" className="container">
                        {groups.map((group) => {
                            const hasURL = group.URL !== undefined && group.URL !== null && group.URL.length > 0;
                            const href = hasURL ? safeHref(group.URL) : undefined;
                            return (
                                <div key={"group_" + keyFor(group)} className="row py-1">
                                    <div className="col text-left">
                                        {hasURL ? (
                                            <span>
                                                {href !== undefined ? (
                                                    <a href={href} target="_blank" rel="noopener noreferrer">
                                                        {group.URLshort}
                                                    </a>
                                                ) : (
                                                    group.URLshort
                                                )}
                                            </span>
                                        ) : (
                                            <span>{group.filename}</span>
                                        )}
                                        <br />
                                        <span style={{ fontSize: "0.8em" }}>{group.getShorthand()}</span>
                                    </div>
                                    <div className="col-2 text-center">
                                        <button
                                            type="button"
                                            className="btn btn-danger"
                                            onClick={() => onRemove(group)}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                    <div className="col-2 text-center">
                                        <button
                                            type="button"
                                            className="btn btn-info"
                                            onClick={() => onDownload(group)}
                                        >
                                            Download
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
