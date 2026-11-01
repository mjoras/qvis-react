// Option 2: upload (file-loading spec §3.3). All-or-nothing extension validation (N3, PARITY), then every file is
// loaded concurrently and fully client-side. FIX Q6: N5 only after the model accepted the file. FIX Q24: uploads
// count as outstanding requests.

import type { LoadedQlog } from "@/qlog/parse";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { loadQlogFile } from "./fileLoader";
import type { LoadNotification } from "./messages";
import {
    loadErrorNotification,
    N3_badUploadExtension,
    N4_uploadStart,
    N5_uploadDone,
    N6_uploadFailed,
} from "./messages";
import type { FileInfo } from "./shorten";

export interface UploadDeps {
    notify(n: LoadNotification): void;
    addGroupFromQlogFile(
        loaded: LoadedQlog,
        fileInfo: FileInfo,
        success?: LoadNotification,
    ): QlogConnectionGroup | undefined;
    adjustOutstanding(delta: number): void;
}

/** The picker's `accept` attribute, verbatim (Q22: kept although validation accepts more). */
export const UPLOAD_ACCEPT = ".qlog,.sqlog,.json,.netlog";

const UPLOAD_BASE_SUFFIXES = [".qlog", ".sqlog", ".json", ".netlog"];
const UPLOAD_COMPRESSION_SUFFIXES = [".gz", ".gzip", ".br", ".brotli"];

/** qvis suffixes `.qlog .sqlog .json .netlog .qlognd` (case-insensitive, FIX Q19) plus compressed variants (D10). */
export function isUploadAllowed(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower.endsWith(".qlognd")) return true;
    for (const base of UPLOAD_BASE_SUFFIXES) {
        if (lower.endsWith(base)) return true;
        for (const comp of UPLOAD_COMPRESSION_SUFFIXES) if (lower.endsWith(base + comp)) return true;
    }
    return false;
}

async function loadOne(file: File, deps: UploadDeps): Promise<QlogConnectionGroup | undefined> {
    deps.notify(N4_uploadStart(file.name));
    deps.adjustOutstanding(+1);
    try {
        const loaded = await loadQlogFile(file, file.name);
        return deps.addGroupFromQlogFile(loaded, { filename: file.name }, N5_uploadDone(file.name));
    } catch (e) {
        console.error("FileManagerContainer:uploadFile : ", e);
        deps.notify(loadErrorNotification(e, file.name, (detail) => N6_uploadFailed(file.name, detail)));
        return undefined;
    } finally {
        deps.adjustOutstanding(-1);
    }
}

/** qvis `uploadFile()`: validate ALL files first (abort on the first bad one), then load them concurrently. */
export async function loadUploadedFiles(files: readonly File[], deps: UploadDeps): Promise<void> {
    for (const file of files) {
        if (!file || !isUploadAllowed(file.name)) {
            deps.notify(N3_badUploadExtension(file ? file.name : ""));
            return;
        }
    }
    await Promise.allSettled(files.map((file) => loadOne(file, deps)));
}
