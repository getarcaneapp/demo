#!/usr/bin/env node

const [baseUrl, username, password] = process.argv.slice(2);

if (!baseUrl || !username || !password) {
    console.error("Usage: bootstrap-arcane-instance.mjs <base-url> <username> <password>");
    process.exit(1);
}

const REQUEST_TIMEOUT = 10000;

const apiBaseUrl = new URL("/api", ensureTrailingSlash(baseUrl)).toString().replace(/\/$/, "");

try {
    const response = await requestJson("/auth/login", {
        method: "POST",
        body: {
            username,
            password,
        },
    });

    if (!response.data?.token) {
        throw new Error("Arcane login returned no token");
    }
} catch (error) {
    console.error(error.message || error);
    process.exit(isRetryable(error.status) ? 1 : 2);
}

async function requestJson(path, options) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
        method: options.method,
        headers: {
            "Content-Type": "application/json",
            ...(options.token
                ? {
                      Authorization: `Bearer ${options.token}`,
                  }
                : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    const text = await response.text();
    const payload = text ? safeJsonParse(text) : {};

    if (!response.ok) {
        const error = new Error(
            `Request failed for ${path}: ${response.status} ${response.statusText} ${JSON.stringify(payload)}`,
        );
        error.status = response.status;
        throw error;
    }

    return payload;
}

/**
 * Exit code 2 marks a failure that retrying cannot fix (bad request, rejected
 * request, missing route), so the pool can fail fast instead of burning the
 * start budget on three identical attempts.
 */
function isRetryable(status) {
    if (!status) {
        return true;
    }

    return status === 401 || status === 408 || status === 429 || status >= 500;
}

function ensureTrailingSlash(value) {
    return value.endsWith("/") ? value : `${value}/`;
}

function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    } catch (error) {
        return {
            error: value,
        };
    }
}
