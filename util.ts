import fs from "fs";

export function getRandomInt(min : number, max : number) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms : number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const contentTypeMap : Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
};

/**
 * Get the content type of a URL
 * @param url
 */
export function contentType(url : string) {
    let lower = url.toLowerCase();

    for (let [ extension, type ] of Object.entries(contentTypeMap)) {
        if (lower.endsWith(extension)) {
            return type;
        }
    }

    return "application/octet-stream";
}

export function fileExists(file : string) {
    return fs.promises.access(file, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
}

/**
 * Render an unknown thrown value as a single readable line.
 * Child-process errors carry their output on `stderr`/`stdout`, which is
 * usually the only useful part, so surface a trimmed slice of it.
 * @param error Any thrown value
 */
export function describeError(error : unknown) : string {
    if (error === null || error === undefined) {
        return "unknown error";
    }

    if (typeof error === "string") {
        return error;
    }

    let parts : string[] = [];
    let anyError = error as Record<string, unknown>;

    if (error instanceof Error) {
        parts.push(`${error.name}: ${error.message}`);
    } else {
        parts.push(String(error));
    }

    if (typeof anyError.code === "string" || typeof anyError.code === "number") {
        parts.push(`code=${anyError.code}`);
    }

    let stderr = anyError.stderr;

    if (stderr) {
        let text = stderr.toString().trim();
        if (text) {
            parts.push(`stderr=${truncate(text, 2000)}`);
        }
    }

    return parts.join(" ");
}

/**
 * Truncate a string to a maximum length, marking that it was cut.
 * @param value Input string
 * @param maxLength Maximum length of the returned string (excluding the marker)
 */
export function truncate(value : string, maxLength : number) {
    if (value.length <= maxLength) {
        return value;
    }

    return value.slice(0, maxLength) + `… (${value.length - maxLength} more chars)`;
}

/**
 * Escape a string for safe interpolation into HTML text/attribute content.
 * @param value Input string
 */
export function escapeHtml(value : string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
