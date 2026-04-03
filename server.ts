import "dotenv/config";
import { Pool } from "./pool";
import * as http from "http";
import { Duplex } from "stream";
import httpProxy from "http-proxy";
import ejs from "ejs";
import fs from "fs/promises";
import path from "path";
import { contentType, sleep } from "./util";
import gracefulShutdown from "http-graceful-shutdown";
import { entryPath, installURL, serverPort, sessionTime, showEntry, websiteName } from "./config";

// Catch unexpected errors here
let unexpectedErrorHandler = (error : unknown) => {
    console.trace(error);
};
process.addListener("unhandledRejection", unexpectedErrorHandler);
process.addListener("uncaughtException", unexpectedErrorHandler);

const pool = new Pool();
const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
    xfwd: true,
});

await pool.clearInstance();

const server = http.createServer(async (req, res) => {
    try {
        await requestHandler(req, res);
    } catch (e) {
        console.error(e);
        res.writeHead(500);
        res.end("Internal server error");
    }
});

server.on("upgrade", (req, socket, head) => {
    proxyWebSocket(req, socket, head);
});

console.log(`Listening on port ${serverPort}`);
server.listen(serverPort);

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
        let [ key, value ] = cookie.split("=");
        if (key.trim() === "session-id") {
            sessionID = value.trim();
        }
    }

    return sessionID;
}

async function requestHandler(req : http.IncomingMessage, res : http.ServerResponse) {
    if (!req.url) {
        res.end("No url");
        return;
    }

    // Handle request
    if (req.url === "/") {
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

    } else if (req.url === "/start-demo" || req.url === "/start-demo") {
        res.writeHead(200, { "Content-Type": "text/html" });
        let indexTemplate = ejs.render(await fs.readFile("./views/index.ejs", "utf-8"), {
            websiteName,
            installURL,
            autoStart: !showEntry,
            entryPath,
        });
        res.end(indexTemplate);

    } else if (req.url.startsWith("/demo-kuma/")) {
        if (req.url === "/demo" || req.url === "/demo-kuma/") {
            res.writeHead(200, { "Content-Type": "text/html" });
            let indexTemplate = ejs.render(await fs.readFile("./views/index.ejs", "utf-8"), {
                websiteName,
                installURL,
                autoStart: !showEntry,
                entryPath,
            });
            res.end(indexTemplate);

        } else if (req.url === "/demo-kuma/start-instance") {
            try {
                let { endSessionTime, sessionID, credentials } = await pool.startInstance();
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Set-Cookie": `session-id=${sessionID}; Max-Age=${sessionTime}; Path=/;`
                });
                res.end(JSON.stringify({
                    ok: true,
                    sessionID,
                    endSessionTime,
                    credentials,
                }));
            } catch (e) {
                console.error(e);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    ok: false,
                }));
            }

        } else if (req.url === "/demo-kuma/validate-session") {
            let sessionID = getSessionID(req);
            pool.touchSession(sessionID);

            res.writeHead(200, {
                "Content-Type": "application/json",
            });

            let session = pool.getSession(sessionID);
            res.end(JSON.stringify({
                ok: session !== undefined,
                endSessionTime: session?.endSessionTime,
                credentials: session?.credentials,
            }));

        } else if (req.url === "/demo-kuma/heartbeat" && req.method === "POST") {
            let sessionID = getSessionID(req);
            let ok = pool.touchSession(sessionID);

            res.writeHead(ok ? 204 : 404);
            res.end();

        } else if (req.url === "/demo-kuma/end-session" && req.method === "POST") {
            let sessionID = getSessionID(req);

            if (pool.getSession(sessionID)) {
                await pool.stopInstance(sessionID);
            }

            res.writeHead(204, {
                "Set-Cookie": "session-id=; Max-Age=0; Path=/;",
            });
            res.end();

        } else {
            try {
                let data = await fs.readFile(path.join("./public", req.url));
                res.writeHead(200, { "Content-Type": contentType(req.url) });
                res.end(data);
            } catch (e) {
                res.writeHead(404);
                res.end("Not found");
            }
        }

    } else {
        await proxyWeb(req, res);
    }
}

async function proxyWeb(req : http.IncomingMessage, res : http.ServerResponse, retryCount = 0) {
    let target = getProxyTarget(req);

    if (target) {
        pool.touchSession(getSessionID(req));
        proxy.web(req, res, {
            target,
        }, async (err) => {
            if (retryCount <= 10) {
                await sleep(2000);
                await proxyWeb(req, res, retryCount + 1);
            } else {
                res.writeHead(500);
                res.end("Unable to connect to the instance");
            }
        });
    } else {
        res.writeHead(404);
        res.end("Session not found");
    }
}

function proxyWebSocket(req : http.IncomingMessage, socket : Duplex, head : Buffer) {
    let target = getProxyTarget(req);

    if (!target) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }

    proxy.ws(req, socket, head, {
        target,
    }, () => {
        socket.destroy();
    });

    pool.touchSession(getSessionID(req));
}

function getProxyTarget(req : http.IncomingMessage) {
    let sessionID = getSessionID(req);
    return pool.getServiceURL(sessionID);
}

async function shutdownFunction(signal : string | undefined) {
    console.info("Shutdown requested");
    console.info("server", "Called signal: " + signal);
    await pool.clearInstance();
}

/**
 * Final function called before application exits
 */
function finalFunction() {
    console.info("Graceful shutdown successful!");
}
