// Public surface of the loading package (FileLoader port, URL / demo loading, export).

export { loadQlogFile } from "./fileLoader";
export type { LoadInput, LoadOptions } from "./fileLoader";
export {
    classifyExtension,
    isPcapLikeURL,
    sniffContent,
    CONTAINED_SCHEMA,
    SEQUENTIAL_SCHEMA,
    CONTAINED_FORMAT,
    SEQUENTIAL_FORMAT,
} from "./detect";
export type { ContentKind, ExtensionHint, ExtensionInfo } from "./detect";
export {
    ConversionError,
    PcapUnsupportedError,
    ProxyError,
    UnsupportedQlogSchemaError,
    UnsupportedQlogVersionError,
    isFinalLoadError,
    legacyVersionOf,
} from "./errors";
export { loadFromQueryParameters, loadSingleRemote, loadList, loadMulti, pickQuery } from "./urlLoader";
export type { LoaderDeps, Query } from "./urlLoader";
export { loadExamplesForDemo, loadMassiveDemo, loadQlogDirectlyFromURL } from "./demo";
export { downloadGroup, downloadFilename, groupToContainedQlog } from "./exportQlog";
export { buildFileInfo, shortenForFilename, shortenURL } from "./shorten";
export type { FileInfo } from "./shorten";
export { loadUploadedFiles, isUploadAllowed, UPLOAD_ACCEPT } from "./upload";
