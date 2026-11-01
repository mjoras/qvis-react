// Display-name shortening for URL loads (file-loading spec §3.8, exact qvis formulas with slice instead of substr).

export interface FileInfo {
    filename: string;
    URL?: string;
    URLshort?: string;
}

/** `Loaded via URL (<this>)`: first 25 chars + "..." + last 26 chars when longer than 50. */
export function shortenForFilename(urlToLoad: string): string {
    if (urlToLoad.length <= 50) return urlToLoad;
    return urlToLoad.slice(0, 25) + "..." + urlToLoad.slice(urlToLoad.length - 26);
}

/** `group.URLshort`: first 25 chars + "..." + everything from the last "/" (inclusive) when longer than 50. */
export function shortenURL(fullURL: string): string {
    if (fullURL.length <= 50) return fullURL;
    // substr(-1) and slice(-1) agree when there is no "/" at all (lastIndexOf === -1)
    return fullURL.slice(0, 25) + "..." + fullURL.slice(fullURL.lastIndexOf("/"));
}

export function buildFileInfo(urlToLoad: string, fullURL?: string): FileInfo {
    const info: FileInfo = { filename: "Loaded via URL (" + shortenForFilename(urlToLoad) + ")" };
    if (fullURL) {
        info.URL = fullURL;
        info.URLshort = shortenURL(fullURL);
    }
    return info;
}
