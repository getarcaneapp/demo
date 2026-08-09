#!/usr/bin/env node

const [ baseUrl, username, password ] = process.argv.slice(2);

if (!baseUrl || !username || !password) {
    console.error("Usage: bootstrap-arcane-instance.mjs <base-url> <username> <password>");
    process.exit(1);
}

const DEFAULT_USERNAME = "arcane";
const DEFAULT_PASSWORD = "arcane-admin";
const REQUEST_TIMEOUT = 10000;

const apiBaseUrl = new URL("/api", ensureTrailingSlash(baseUrl)).toString().replace(/\/$/, "");

// This script is retried by the pool, so every step has to be safe to repeat.
// Figure out which credentials the instance currently answers to, and only run
// the steps that are still outstanding.
const states = [
    {
        credentials: [ DEFAULT_USERNAME, DEFAULT_PASSWORD ],
        needsPasswordChange: true,
        needsRename: true,
    },
    {
        // Password already rotated, rename did not land.
        credentials: [ DEFAULT_USERNAME, password ],
        needsPasswordChange: false,
        needsRename: true,
    },
    {
        // Fully bootstrapped already.
        credentials: [ username, password ],
        needsPasswordChange: false,
        needsRename: false,
    },
];

try {
    await run();
} catch (error) {
    console.error(error.message || error);
    process.exit(isRetryable(error.status) ? 1 : 2);
}

async function run() {
    let state = null;
    let token = null;

    for (const candidate of states) {
        const result = await tryLogin(candidate.credentials[0], candidate.credentials[1]);

        if (result) {
            state = candidate;
            token = result;
            break;
        }
    }

    if (!token) {
        throw new Error("Arcane bootstrap could not log in with any known credentials");
    }

    if (!state.needsPasswordChange && !state.needsRename) {
        return;
    }

    const currentUserResponse = await requestJson("/auth/me", {
        method: "GET",
        token,
    });

    const userId = currentUserResponse.data?.id;

    if (!userId) {
        throw new Error("Arcane bootstrap could not resolve the current user");
    }

    if (state.needsPasswordChange) {
        await requestJson("/auth/password", {
            method: "POST",
            token,
            body: {
                currentPassword: DEFAULT_PASSWORD,
                newPassword: password,
            },
        });
    }

    if (state.needsRename) {
        await requestJson(`/users/${userId}`, {
            method: "PUT",
            token,
            body: {
                username,
            },
        });
    }
}

async function tryLogin(user, pass) {
    try {
        const response = await requestJson("/auth/login", {
            method: "POST",
            body: {
                username: user,
                password: pass,
            },
        });
        return response.data?.token ?? null;
    } catch (error) {
        return null;
    }
}

async function requestJson(path, options) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
        method: options.method,
        headers: {
            "Content-Type": "application/json",
            ...(options.token ? {
                "Authorization": `Bearer ${options.token}`,
            } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    const text = await response.text();
    const payload = text ? safeJsonParse(text) : {};

    if (!response.ok) {
        const error = new Error(`Request failed for ${path}: ${response.status} ${response.statusText} ${JSON.stringify(payload)}`);
        error.status = response.status;
        throw error;
    }

    return payload;
}

/**
 * Exit code 2 marks a failure that retrying cannot fix (bad request, rejected
 * password, missing route), so the pool can fail fast instead of burning the
 * start budget on three identical attempts.
 */
function isRetryable(status) {
    if (!status) {
        return true;
    }

    return status === 408 || status === 429 || status >= 500;
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
