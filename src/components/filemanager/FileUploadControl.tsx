// Bootstrap 4 / BootstrapVue 2.0 <b-form-file> look-alike (file-loading spec §2.5, §8.5): hidden multi-file input
// under a "custom-file-label" with a "Browse" segment, drag state, and the red/green validation state (Q9 preserved).
// DOM as BootstrapVue renders it: `div#<id>__BV_file_outer_.custom-file.b-form-file.<state>` > input + label
// (`.dragging` on the label while files are dragged over the control).

import { useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

export interface FileUploadControlProps {
    id: string;
    files: readonly File[];
    onFilesChange(files: File[]): void;
    accept: string;
    placeholder: string;
    dropPlaceholder: string;
    /** BootstrapVue `state`: false = invalid (red), true = valid (green). */
    state: boolean;
}

function hasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return types !== undefined && Array.from(types).includes("Files");
}

export default function FileUploadControl(props: FileUploadControlProps) {
    const { id, files, onFilesChange, accept, placeholder, dropPlaceholder, state } = props;
    const [dragging, setDragging] = useState(false);

    const label = dragging ? dropPlaceholder : files.length > 0 ? files.map((f) => f.name).join(", ") : placeholder;
    const stateClass = state ? "is-valid" : "is-invalid";

    function onDragOver(e: DragEvent<HTMLDivElement>) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dragging) setDragging(true);
    }

    function onDragLeave() {
        setDragging(false);
    }

    function onDrop(e: DragEvent<HTMLDivElement>) {
        e.preventDefault(); // replaces the selection; no `accept` filtering on drop (BootstrapVue 2.0.4 parity)
        setDragging(false);
        const dropped = Array.from(e.dataTransfer?.files ?? []);
        if (dropped.length > 0) onFilesChange(dropped);
    }

    function onChange(e: ChangeEvent<HTMLInputElement>) {
        onFilesChange(Array.from(e.target.files ?? []));
    }

    return (
        <div
            id={id + "__BV_file_outer_"}
            className={"custom-file b-form-file text-nowrap text-truncate " + stateClass}
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <input
                id={id}
                type="file"
                multiple
                accept={accept}
                className={"custom-file-input " + stateClass}
                onChange={onChange}
            />
            <label htmlFor={id} className={"custom-file-label" + (dragging ? " dragging" : "")} data-browse="Browse">
                {label}
            </label>
        </div>
    );
}
