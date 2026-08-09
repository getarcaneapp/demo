import "dotenv/config";
import { NotReadyError, Pool, SessionLimitError } from "./pool";
import * as http from "http";
import { Duplex } from "stream";
import httpProxy from "http-proxy";
import ejs from "ejs";
import fs from "fs/promises";
import path from "path";
import { contentType, describeError, sleep } from "./util";
import gracefulShutdown from "http-graceful-shutdown";
import {
    appURL,
    entryPath,
    installURL,
    maxSessions,
    serverPort,
    sessionTime,
    showEntry,
    startRateLimitMax,
    startRateLimitWindow,
    trustProxy,
    websiteName,
} from "./config";

// Catch unexpected errors here
let unexpectedErrorHandler = (error : unknown) => {
    console.trace(error);
};
process.addListener("unhandledRejection", unexpectedErrorHandler);
process.addListener("uncaughtException", unexpectedErrorHandler);

const publicRoot = path.resolve("./public");
const startedAt = Date.now();

/** Retries only ever apply to bodyless methods; a consumed request body cannot be replayed. */
const retryableMethods = new Set([ "GET", "HEAD", "OPTIONS" ]);
const maxProxyRetries = 2;

/** Interval at which expired rate-limit buckets are dropped. */
const rateLimitSweepInterval = 60000;

const pool = new Pool();
const proxy = httpProxy.createProxyServer({
    ws: true,
    // Deliberately NOT changeOrigin: rewriting Host to the container IP makes
    // Arcane's websocket origin check compare the browser's Origin against
    // "<container-ip>:<port>", which never matches and silently drops the
    // upgrade. Passing the real Host through keeps Origin == Host.
    changeOrigin: false,
    xfwd: true,
});

// Without this, an ECONNRESET from a client mid-proxy is an unhandled "error"
// event on the proxy emitter, which takes the whole process down.
proxy.on("error", (err, req, res) => {
    console.warn(`[proxy] ${describeError(err)}`);
});

const server = http.createServer(async (req, res) => {
    try {
        await requestHandler(req, res);
    } catch (e) {
        console.error(`[request] ${req.method} ${req.url} failed: ${describeError(e)}`);

        if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }

        res.end("Internal server error");
    }
});

server.on("upgrade", (req, socket, head) => {
    proxyWebSocket(req, socket, head);
});

server.on("clientError", (err, socket) => {
    if (!socket.destroyed) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
});

server.listen(serverPort, () => {
    console.log(`Listening on port ${serverPort}`);
});

// Boot cleanup runs *after* listen and retries internally, so an unreachable
// Docker socket degrades the service instead of crash-looping the container.
pool.initialize().then(() => {
    pool.startHealthSweep();
});

const rateLimitTimer = setInterval(sweepRateLimits, rateLimitSweepInterval);

gracefulShutdown(server, {
    signals: "SIGINT SIGTERM",
    timeout: 30000,                   // timeout: 30 secs
    development: false,               // not in dev mode
    forceExit: true,                  // triggers process.exit() at the end of shutdown process
    onShutdown: shutdownFunction,     // shutdown function (async) - e.g. for cleanup DB, ...
    finally: finalFunction,            // finally function (sync) - e.g. for logging
});

/**
 * Get session ID from cookie
 * @param req
 */
function getSessionID(req : http.IncomingMessage) {
    let cookieList = req.headers.cookie?.split(";") || [];
    let sessionID = "";

    for (let cookie of cookieList) {
        let separator = cookie.indexOf("=");

        if (separator === -1) {
            continue;
        }

        let key = cookie.slice(0, separator).trim();

        if (key === "session-id") {
            sessionID = cookie.slice(separator + 1).trim();
        }
    }

    return sessionID;
}

/**
 * Build the session cookie. HttpOnly because the value is the only credential
 * guarding a live instance, so page scripts have no business reading it.
 * @param sessionID Session ID, or empty string to clear the cookie
 * @param maxAge Cookie lifetime in seconds
 */
function sessionCookie(sessionID : string, maxAge : number) {
    let parts = [
        `session-id=${sessionID}`,
        `Max-Age=${maxAge}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
    ];

    if (appURL.startsWith("https://")) {
        parts.push("Secure");
    }

    return parts.join("; ");
}

/**
 * Resolve the client IP used for rate limiting.
 * @param req
 */
function getClientIP(req : http.IncomingMessage) {
    if (trustProxy) {
        let forwarded = req.headers["x-forwarded-for"];
        let raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        let first = raw?.split(",")[0]?.trim();

        if (first) {
            return first;
        }
    }

    return req.socket.remoteAddress || "unknown";
}

const startAttempts = new Map<string, number[]>();

function sweepRateLimits() {
    let cutoff = Date.now() - startRateLimitWindow * 1000;

    for (let [ ip, attempts ] of startAttempts) {
        let fresh = attempts.filter(time => time > cutoff);

        if (fresh.length === 0) {
            startAttempts.delete(ip);
        } else {
            startAttempts.set(ip, fresh);
        }
    }
}

/**
 * Record a start attempt and report whether it is within the per-IP budget.
 * @param ip Client IP
 */
function allowStartAttempt(ip : string) {
    let cutoff = Date.now() - startRateLimitWindow * 1000;
    let attempts = (startAttempts.get(ip) || []).filter(time => time > cutoff);

    if (attempts.length >= startRateLimitMax) {
        startAttempts.set(ip, attempts);
        return false;
    }

    attempts.push(Date.now());
    startAttempts.set(ip, attempts);
    return true;
}

async function renderIndex(res : http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    let indexTemplate = ejs.render(await fs.readFile("./views/index.ejs", "utf-8"), {
        websiteName,
        installURL,
        autoStart: !showEntry,
        entryPath,
    });
    res.end(indexTemplate);
}

function sendJson(res : http.ServerResponse, status : number, body : unknown, headers : http.OutgoingHttpHeaders = {}) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        ...headers,
    });
    res.end(JSON.stringify(body));
}

async function requestHandler(req : http.IncomingMessage, res : http.ServerResponse) {
    if (!req.url) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("No url");
        return;
    }

    let pathname : string;

    try {
        pathname = new URL(req.url, "http://localhost").pathname;
    } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad request");
        return;
    }

    // Handle request
    if (pathname === "/") {
        let sessionID = getSessionID(req);
        let target = pool.getServiceURL(sessionID);

        // If a session is found, proxy it
        if (sessionID && target) {
            await proxyWeb(req, res);
        } else {
            // Redirect to "/start"
            res.writeHead(302, {
                "Location": "/start-demo",
            });
            res.end();
        }

    } else if (pathname === "/healthz") {
        let docker = await pool.checkDockerHealth();
        let ok = pool.isBooted() && docker.ok;

        sendJson(res, ok ? 200 : 503, {
            ok,
            booted: pool.isBooted(),
            sessions: pool.sessionCount(),
            maxSessions,
            docker: {
                ok: docker.ok,
                error: docker.error,
            },
            uptime: Math.floor((Date.now() - startedAt) / 1000),
        });

    } else if (pathname === "/start-demo" || pathname === "/demo" || pathname === "/demo-kuma/") {
        await renderIndex(res);

    } else if (pathname === "/demo-kuma/start-instance") {
        await handleStartInstance(req, res);

    } else if (pathname === "/demo-kuma/validate-session") {
        let sessionID = getSessionID(req);
        pool.touchSession(sessionID);

        let session = pool.getSession(sessionID);
        sendJson(res, 200, {
            ok: session !== undefined,
            endSessionTime: session?.endSessionTime,
            credentials: session?.credentials,
        });

    } else if (pathname === "/demo-kuma/heartbeat" && req.method === "POST") {
        let sessionID = getSessionID(req);
        let ok = pool.touchSession(sessionID);

        res.writeHead(ok ? 204 : 404);
        res.end();

    } else if (pathname === "/demo-kuma/end-session" && req.method === "POST") {
        let sessionID = getSessionID(req);

        if (pool.getSession(sessionID)) {
            await pool.stopInstance(sessionID);
        }

        res.writeHead(204, {
            "Set-Cookie": sessionCookie("", 0),
        });
        res.end();

    } else if (pathname.startsWith("/demo-kuma/")) {
        await serveStatic(pathname, res);

    } else {
        await proxyWeb(req, res);
    }
}

async function handleStartInstance(req : http.IncomingMessage, res : http.ServerResponse) {
    // POST only: crawlers and link prefetchers would otherwise spin up stacks.
    if (req.method !== "POST") {
        sendJson(res, 405, {
            ok: false,
            reason: "method-not-allowed",
        }, { "Allow": "POST" });
        return;
    }

    let ip = getClientIP(req);

    if (!allowStartAttempt(ip)) {
        console.warn(`[rate-limit] ${ip} exceeded ${startRateLimitMax} starts per ${startRateLimitWindow}s`);
        sendJson(res, 429, {
            ok: false,
            reason: "rate-limited",
            retryAfter: startRateLimitWindow,
        }, { "Retry-After": String(startRateLimitWindow) });
        return;
    }

    try {
        let { endSessionTime, sessionID, credentials } = await pool.startInstance();
        sendJson(res, 200, {
            ok: true,
            endSessionTime,
            credentials,
        }, {
            "Set-Cookie": sessionCookie(sessionID, sessionTime),
        });
    } catch (e) {
        if (e instanceof SessionLimitError || e instanceof NotReadyError) {
            let retryAfter = 30;
            console.warn(`[start-instance] ${e.name}: ${e.message}`);
            sendJson(res, 503, {
                ok: false,
                reason: e instanceof SessionLimitError ? "busy" : "starting",
                retryAfter,
            }, { "Retry-After": String(retryAfter) });
            return;
        }

        console.error(`[start-instance] failed: ${describeError(e)}`);
        sendJson(res, 500, {
            ok: false,
            reason: "error",
        });
    }
}

/**
 * Serve a file from ./public, refusing anything that escapes the directory.
 * @param pathname Decoded-safe URL pathname (query string already stripped)
 * @param res
 */
async function serveStatic(pathname : string, res : http.ServerResponse) {
    let decoded : string;

    try {
        decoded = decodeURIComponent(pathname);
    } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad request");
        return;
    }

    // Reject NUL and any traversal that resolves outside ./public.
    let filePath = path.resolve(path.join(publicRoot, decoded));

    if (decoded.includes("\0") || !filePath.startsWith(publicRoot + path.sep)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
    }

    try {
        let data = await fs.readFile(filePath);
        res.writeHead(200, { "Content-Type": contentType(filePath) });
        res.end(data);
    } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    }
}

function errorPage(title : string, message : string) {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; background: #090C10; color: #F0F6FC; text-align: center; padding-top: 15vh;">
<h2>${title}</h2>
<p>${message}</p>
</body>
</html>`;
}

async function proxyWeb(req : http.IncomingMessage, res : http.ServerResponse, retryCount = 0) {
    let target = getProxyTarget(req);

    if (!target) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorPage("Session not found", "Your demo session has ended. <a style=\"color:#c4b5fd\" href=\"/start-demo\">Start a new one</a>."));
        return;
    }

    pool.touchSession(getSessionID(req));

    proxy.web(req, res, {
        target,
    }, async (err) => {
        // The request body (if any) is already consumed at this point, so only
        // bodyless methods can be replayed safely.
        let canRetry = retryCount < maxProxyRetries
            && retryableMethods.has(req.method || "")
            && !res.headersSent
            && !req.destroyed;

        if (canRetry) {
            console.warn(`[proxy] retry ${retryCount + 1}/${maxProxyRetries} for ${req.method} ${req.url}: ${describeError(err)}`);
            await sleep(500);
            await proxyWeb(req, res, retryCount + 1);
            return;
        }

        console.error(`[proxy] ${req.method} ${req.url} failed: ${describeError(err)}`);

        if (res.headersSent) {
            res.destroy();
            return;
        }

        res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorPage("Demo unavailable", "Unable to reach your demo instance. Try reloading the page in a moment."));
    });
}

function proxyWebSocket(req : http.IncomingMessage, socket : Duplex, head : Buffer) {
    // A client that disappears mid-upgrade emits ECONNRESET on this socket;
    // without a listener that is an uncaught exception.
    socket.on("error", (err) => {
        console.warn(`[ws] socket error: ${describeError(err)}`);
    });

    let target = getProxyTarget(req);

    if (!target) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }

    let sessionID = getSessionID(req);
    pool.touchSession(sessionID);

    // Long-lived websockets carry no HTTP requests, so without this a user who is
    // actively using the UI over a socket still looks idle. Do NOT do this with
    // socket.on("data"): attaching a data listener flips the socket into flowing
    // mode before http-proxy pipes it, and client frames get dropped.
    let keepAlive = setInterval(() => {
        if (socket.destroyed) {
            clearInterval(keepAlive);
            return;
        }

        pool.touchSession(sessionID);
    }, 15000);

    socket.on("close", () => clearInterval(keepAlive));

    proxy.ws(req, socket, head, {
        target,
    }, (err) => {
        console.warn(`[ws] proxy error for ${req.url}: ${describeError(err)}`);
        socket.destroy();
    });
}

function getProxyTarget(req : http.IncomingMessage) {
    let sessionID = getSessionID(req);
    return pool.getServiceURL(sessionID);
}

async function shutdownFunction(signal : string | undefined) {
    console.info("Shutdown requested");
    console.info("server", "Called signal: " + signal);
    clearInterval(rateLimitTimer);
    await pool.shutdownAll();
}

/**
 * Final function called before application exits
 */
function finalFunction() {
    console.info("Graceful shutdown successful!");
}
