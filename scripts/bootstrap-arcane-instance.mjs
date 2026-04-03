#!/usr/bin/env node

const [ baseUrl, username, password ] = process.argv.slice(2);

if (!baseUrl || !username || !password) {
    console.error("Usage: bootstrap-arcane-instance.mjs <base-url> <username> <password>");
    process.exit(1);
}

const apiBaseUrl = new URL("/api", ensureTrailingSlash(baseUrl)).toString().replace(/\/$/, "");

const loginResponse = await requestJson("/auth/login", {
    method: "POST",
    body: {
        username: "arcane",
        password: "arcane-admin",
    },
});

const token = loginResponse.data?.token;

if (!token) {
    throw new Error("Arcane bootstrap login did not return an access token");
}

const currentUserResponse = await requestJson("/auth/me", {
    method: "GET",
    token,
});

const userId = currentUserResponse.data?.id;

if (!userId) {
    throw new Error("Arcane bootstrap could not resolve the current user");
}

await requestJson("/auth/password", {
    method: "POST",
    token,
    body: {
        currentPassword: "arcane-admin",
        newPassword: password,
    },
});

await requestJson(`/users/${userId}`, {
    method: "PUT",
    token,
    body: {
        username,
    },
});

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
    });

    const text = await response.text();
    const payload = text ? safeJsonParse(text) : {};

    if (!response.ok) {
        throw new Error(`Request failed for ${path}: ${response.status} ${response.statusText} ${JSON.stringify(payload)}`);
    }

    return payload;
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
