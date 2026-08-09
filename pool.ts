import childProcessAsync from "promisify-child-process";
import { describeError, sleep, truncate } from "./util";
import crypto from "crypto";
import {
    sessionTime,
    sessionIdleTimeout,
    stackPrefix,
    startTimeout,
    bootstrapTimeout,
    servicePort,
    healthPath,
    dockerNetwork,
    serviceName,
    maxSessions,
    healthSweepInterval,
    healthSweepFailureLimit,
} from "./config";

/** Cap on captured child-process output, so a chatty compose run cannot eat the heap. */
const maxBuffer = 10 * 1024 * 1024;

/** Timeout applied to a single readiness probe of a starting instance. */
const readinessProbeTimeout = 5000;

/** Timeout applied to health probes of running instances. */
const healthProbeTimeout = 5000;

/** How long a cached `docker version` result stays fresh for /healthz. */
const dockerHealthCacheTime = 10000;

interface SessionCredentials {
    username: string;
    password: string;
}

interface SessionInfo {
    /** Cookie value. 128-bit random: it is the only credential guarding a live instance. */
    sessionID: string;
    /** Compose project name for this session's stack. Short, unique, not secret. */
    projectName: string;
    baseURL: string;
    startedAt: number;
    endSessionTime: number;
    credentials: SessionCredentials;
    timeout?: NodeJS.Timeout;
    idleTimeout?: NodeJS.Timeout;
    /** False while the stack is still starting up; such sessions are never proxied to. */
    ready: boolean;
    /** Consecutive failed health probes. */
    healthFailures: number;
    /** Guards against a stop running twice (timer + explicit end racing). */
    stopping: boolean;
}

/** Thrown when the concurrency cap is hit. Mapped to HTTP 503 by the server. */
export class SessionLimitError extends Error {
    constructor(message = "The demo is at capacity") {
        super(message);
        this.name = "SessionLimitError";
    }
}

/** Thrown when a start is requested before the boot cleanup sweep finished. */
export class NotReadyError extends Error {
    constructor(message = "The demo is still starting up") {
        super(message);
        this.name = "NotReadyError";
    }
}

export class Pool {
    /**
     * sessionList[sessionID] = session metadata
     */
    sessionList: Record<string, SessionInfo> = {};

    /** True once the boot cleanup sweep succeeded and Docker is known to work. */
    private booted = false;

    /** Serializes admission checks so concurrent requests cannot both pass the cap. */
    private admissionChain : Promise<unknown> = Promise.resolve();

    private sweepTimer : NodeJS.Timeout | undefined;

    private dockerHealth : { ok : boolean, error : string | null, checkedAt : number } = {
        ok: false,
        error: "not checked yet",
        checkedAt: 0,
    };

    isBooted() {
        return this.booted;
    }

    sessionCount() {
        return Object.keys(this.sessionList).length;
    }

    /**
     * Clean up leftover stacks from a previous run, retrying until Docker answers.
     * Called after the HTTP server is already listening so an unreachable Docker
     * socket cannot turn into a boot crash loop.
     */
    async initialize() {
        for (let attempt = 1; ; attempt++) {
            try {
                await this.clearInstance();
                this.booted = true;
                console.log("Pool ready");
                return;
            } catch (error) {
                let delay = Math.min(30000, 2000 * attempt);
                console.error(`Pool init attempt ${attempt} failed (retrying in ${delay}ms): ${describeError(error)}`);
                await sleep(delay);
            }
        }
    }

    async startInstance() {
        if (!this.booted) {
            throw new NotReadyError();
        }

        // Reserve a slot and register the session *before* touching Docker, so a
        // crash mid-start cannot leave an untracked stack behind and so concurrent
        // requests cannot both slip past the cap.
        let session = await this.reserveSession();
        let startedAt = Date.now();

        console.log(`[${session.projectName}] Starting session (${this.sessionCount()}/${maxSessions} slots used)`);

        try {
            let result = await this.runDockerCompose(session.projectName, [
                "up",
                "-d",
            ]);

            if (result.stderr) {
                console.log(`[${session.projectName}] compose up: ${truncate(result.stderr.toString().trim(), 2000)}`);
            }

            session.baseURL = await this.waitForService(session.projectName);

            await this.bootstrapArcaneInstance(session.projectName, session.baseURL, session.credentials);

            session.endSessionTime = Date.now() + sessionTime * 1000;
            session.timeout = setTimeout(() => {
                console.log(`[${session.projectName}] Time's up`);
                this.stopInstance(session.sessionID).catch((error) => {
                    console.error(`[${session.projectName}] Failed to stop on session timeout: ${describeError(error)}`);
                });
            }, sessionTime * 1000);
            session.idleTimeout = this.createIdleTimeout(session.sessionID);
            session.ready = true;

            console.log(`[${session.projectName}] Session started in ${Date.now() - startedAt}ms`);

            return {
                sessionID: session.sessionID,
                endSessionTime: session.endSessionTime,
                credentials: session.credentials,
            };
        } catch (error) {
            console.error(`[${session.projectName}] Session failed to start after ${Date.now() - startedAt}ms: ${describeError(error)}`);
            // Tear the half-started stack down now instead of leaking it until the
            // next restart sweep.
            await this.stopInstance(session.sessionID);
            throw error;
        }
    }

    async stopInstance(sessionID : string) {
        let session = this.sessionList[sessionID];

        if (!session || session.stopping) {
            return;
        }

        session.stopping = true;
        clearTimeout(session.timeout);
        clearTimeout(session.idleTimeout);

        // Free the slot immediately; the compose down below can take seconds.
        delete this.sessionList[sessionID];

        let stoppedAt = Date.now();
        await this.stopComposeProject(session.projectName);
        console.log(`[${session.projectName}] Session stopped in ${Date.now() - stoppedAt}ms (lifetime ${Date.now() - session.startedAt}ms)`);
    }

    getServiceURL(sessionID : string) : string | undefined {
        let session = this.sessionList[sessionID];

        if (!session || !session.ready) {
            return undefined;
        }

        return session.baseURL;
    }

    getSession(sessionID : string) {
        let session = this.sessionList[sessionID];
        return session?.ready ? session : undefined;
    }

    touchSession(sessionID : string) {
        let session = this.getSession(sessionID);

        if (!session) {
            return false;
        }

        clearTimeout(session.idleTimeout);
        session.idleTimeout = this.createIdleTimeout(sessionID);
        return true;
    }

    /**
     * Stop every stack we know about plus any leftovers found on the Docker host.
     * Throws if the Docker host cannot be queried, so callers can retry at boot.
     */
    async clearInstance() {
        let known = Object.values(this.sessionList);

        // Clear timers *before* dropping the list, otherwise a stale timer can fire
        // later and `docker compose down` a project name that has been reused.
        for (let session of known) {
            session.stopping = true;
            clearTimeout(session.timeout);
            clearTimeout(session.idleTimeout);
        }

        this.sessionList = {};

        let projectNames = new Set(known.map(session => session.projectName));

        for (let name of await this.listStackProjects()) {
            projectNames.add(name);
        }

        if (projectNames.size === 0) {
            return;
        }

        console.log(`Clearing ${projectNames.size} stack(s)`);

        // In parallel: a sequential loop can blow the 30s graceful-shutdown budget.
        await Promise.allSettled([ ...projectNames ].map(name => this.stopComposeProject(name)));
    }

    /**
     * Shutdown path. Best effort: never throws, so graceful shutdown always finishes.
     */
    async shutdownAll() {
        this.stopHealthSweep();

        try {
            await this.clearInstance();
        } catch (error) {
            console.error(`Failed to clear stacks on shutdown: ${describeError(error)}`);
        }
    }

    startHealthSweep() {
        if (this.sweepTimer) {
            return;
        }

        this.sweepTimer = setInterval(() => {
            this.sweepDeadInstances().catch((error) => {
                console.error(`Health sweep failed: ${describeError(error)}`);
            });
        }, healthSweepInterval * 1000);
    }

    stopHealthSweep() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
    }

    /**
     * Per-session stacks run with `restart: no`, so a crashed Arcane container
     * leaves a live session pointing at a dead target. Probe and reap them.
     */
    async sweepDeadInstances() {
        let sessions = Object.values(this.sessionList).filter(session => session.ready && !session.stopping);

        await Promise.allSettled(sessions.map(async (session) => {
            let alive = await this.probeInstance(session.baseURL);

            if (alive) {
                session.healthFailures = 0;
                return;
            }

            session.healthFailures++;
            console.warn(`[${session.projectName}] Health probe failed (${session.healthFailures}/${healthSweepFailureLimit})`);

            if (session.healthFailures >= healthSweepFailureLimit) {
                console.warn(`[${session.projectName}] Instance is dead, ending session`);
                await this.stopInstance(session.sessionID);
            }
        }));
    }

    /**
     * Report whether the Docker host is reachable. Cached briefly so /healthz
     * cannot be used to spawn one child process per request.
     */
    async checkDockerHealth() {
        if (Date.now() - this.dockerHealth.checkedAt < dockerHealthCacheTime) {
            return this.dockerHealth;
        }

        try {
            await childProcessAsync.spawn("docker", [
                "version",
                "--format",
                "{{.Server.Version}}",
            ], {
                encoding: "utf-8",
                maxBuffer,
                timeout: 5000,
            });
            this.dockerHealth = {
                ok: true,
                error: null,
                checkedAt: Date.now(),
            };
        } catch (error) {
            this.dockerHealth = {
                ok: false,
                error: describeError(error),
                checkedAt: Date.now(),
            };
        }

        return this.dockerHealth;
    }

    /**
     * Resolve the container IP of a session's main service.
     * @param projectName Compose project name
     */
    async getServiceIP(projectName : string) : Promise<string> {
        let containerID = await this.getServiceContainerID(projectName);

        let response = await childProcessAsync.spawn("docker", [
            "inspect",
            containerID,
        ], {
            encoding: "utf-8",
            maxBuffer,
            timeout: 15000,
        });

        if (typeof response.stdout !== "string") {
            throw new Error("No output");
        }

        let array = JSON.parse(response.stdout);

        if (!Array.isArray(array)) {
            throw new Error("Not an array");
        }

        if (array.length === 0) {
            throw new Error("Array is empty");
        }

        let obj = array[0];

        // Check if the object is valid
        if (!obj || typeof obj !== "object") {
            throw new Error("Not an object");
        }

        let networkSettings = obj.NetworkSettings;

        if (!networkSettings) {
            throw new Error("No network settings");
        }

        let networks = networkSettings.Networks;

        if (!networks) {
            throw new Error("No networks");
        }

        // Find the target network
        let network = networks[dockerNetwork];

        if (!network) {
            throw new Error(`Network "${dockerNetwork}" not found on container ${containerID}`);
        }

        let ip = network.IPAddress;

        if (!ip) {
            throw new Error("IP not found");
        }

        return ip;
    }

    /**
     * Ask compose which container backs the main service, instead of guessing
     * `<project>-<service>-1` by convention.
     * @param projectName Compose project name
     */
    private async getServiceContainerID(projectName : string) : Promise<string> {
        let response = await this.runDockerCompose(projectName, [
            "ps",
            "--format", "json",
            "--status", "running",
            serviceName,
        ]);

        if (typeof response.stdout !== "string") {
            throw new Error("No output from compose ps");
        }

        let entries = parseComposePs(response.stdout);
        let entry = entries.find(item => item.Service === serviceName) ?? entries[0];

        if (!entry) {
            throw new Error(`Service "${serviceName}" is not running yet`);
        }

        let id = entry.ID || entry.Name;

        if (!id) {
            throw new Error("compose ps returned an entry without an ID");
        }

        return id;
    }

    /**
     * Poll the instance until its health endpoint answers 200, or the start
     * budget runs out. Every probe is bounded, so a hung instance can never hold
     * a start open forever.
     * @param projectName Compose project name
     */
    private async waitForService(projectName : string) : Promise<string> {
        let deadline = Date.now() + startTimeout * 1000;
        let lastError : unknown = "no attempt completed";
        let baseURL = "";

        while (true) {
            // Check the deadline *before* each attempt so a slow probe cannot make
            // the loop overrun the budget by a full probe timeout.
            if (Date.now() >= deadline) {
                throw new Error(`Start instance timeout after ${startTimeout}s; last error: ${describeError(lastError)}`);
            }

            try {
                let ip = await this.getServiceIP(projectName);
                baseURL = `http://${ip}:${servicePort}`;

                let response = await fetch(baseURL + healthPath, {
                    signal: AbortSignal.timeout(readinessProbeTimeout),
                });
                await response.text();

                if (response.status === 200) {
                    return baseURL;
                }

                lastError = new Error(`Health check ${baseURL}${healthPath} returned HTTP ${response.status}`);
            } catch (error) {
                lastError = error;
            }

            await sleep(2000);
        }
    }

    private async probeInstance(baseURL : string) {
        try {
            let response = await fetch(baseURL + healthPath, {
                signal: AbortSignal.timeout(healthProbeTimeout),
            });
            await response.text();
            return response.status === 200;
        } catch (error) {
            return false;
        }
    }

    /**
     * Atomically check the concurrency cap and register a placeholder session.
     */
    private reserveSession() : Promise<SessionInfo> {
        let run = () => {
            if (this.sessionCount() >= maxSessions) {
                throw new SessionLimitError(`All ${maxSessions} demo slots are in use`);
            }

            let sessionID = crypto.randomBytes(16).toString("hex");
            let projectName = this.generateProjectName();

            let session : SessionInfo = {
                sessionID,
                projectName,
                baseURL: "",
                startedAt: Date.now(),
                endSessionTime: 0,
                credentials: this.generateCredentials(),
                ready: false,
                healthFailures: 0,
                stopping: false,
            };

            this.sessionList[sessionID] = session;
            return session;
        };

        // Chain onto the previous admission, whether it settled or failed.
        let result = this.admissionChain.then(run, run);
        this.admissionChain = result.catch(() => undefined);
        return result;
    }

    private generateProjectName() {
        let used = new Set(Object.values(this.sessionList).map(session => session.projectName));

        while (true) {
            let candidate = `${stackPrefix}-${crypto.randomBytes(4).toString("hex")}`;

            if (!used.has(candidate)) {
                return candidate;
            }
        }
    }

    private generateCredentials() : SessionCredentials {
        return {
            username: `demo-${crypto.randomBytes(3).toString("hex")}`,
            password: generatePassword(),
        };
    }

    /**
     * Run the bootstrap script that renames the default admin and rotates its
     * password. Retried because Arcane can accept connections a moment before its
     * auth tables are usable; the script itself is idempotent.
     * @param projectName Compose project name (for logging)
     * @param baseURL Instance base URL
     * @param credentials Credentials to install on the instance
     */
    private async bootstrapArcaneInstance(projectName : string, baseURL : string, credentials : SessionCredentials) {
        let attempts = 3;
        let lastError : unknown;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                await childProcessAsync.spawn("node", [
                    "./scripts/bootstrap-arcane-instance.mjs",
                    baseURL,
                    credentials.username,
                    credentials.password,
                ], {
                    encoding: "utf-8",
                    maxBuffer,
                    timeout: bootstrapTimeout * 1000,
                });
                return;
            } catch (error) {
                lastError = error;
                console.warn(`[${projectName}] Bootstrap attempt ${attempt}/${attempts} failed: ${describeError(error)}`);

                // Exit code 2 means the instance rejected the request outright
                // (bad password policy, unknown route). Retrying is pure delay.
                if ((error as { code? : unknown })?.code === 2) {
                    break;
                }

                if (attempt < attempts) {
                    await sleep(1000 * attempt);
                }
            }
        }

        throw new Error(`Bootstrap failed after ${attempts} attempts: ${describeError(lastError)}`);
    }

    private async runDockerCompose(projectName : string, args : string[]) {
        if (!process.env.ENCRYPTION_KEY || !process.env.JWT_SECRET) {
            throw new Error("ENCRYPTION_KEY and JWT_SECRET must be set");
        }

        return childProcessAsync.spawn("docker", [
            "compose",
            "--file", "compose-demo.yaml",
            "-p", projectName,
            ...args,
        ], {
            encoding: "utf-8",
            maxBuffer,
            env: {
                ...process.env,
                DOCKER_NETWORK_NAME: dockerNetwork,
            },
        });
    }

    /**
     * List compose projects belonging to this demo. Throws when Docker is
     * unreachable or returns something unparseable.
     */
    private async listStackProjects() : Promise<string[]> {
        let result = await childProcessAsync.spawn("docker", [
            "compose",
            "ls",
            "--all",
            "--format", "json",
        ], {
            encoding: "utf-8",
            maxBuffer,
            timeout: 30000,
        });

        if (typeof result.stdout !== "string") {
            throw new Error("No output from docker compose ls");
        }

        let list : unknown;

        try {
            list = JSON.parse(result.stdout);
        } catch (error) {
            throw new Error(`Could not parse docker compose ls output: ${describeError(error)}`);
        }

        if (!Array.isArray(list)) {
            throw new Error("docker compose ls did not return an array");
        }

        return list
            .map(stack => stack?.Name)
            .filter((name) : name is string => typeof name === "string" && name.startsWith(stackPrefix + "-"));
    }

    private async stopComposeProject(projectName : string) {
        try {
            return await this.runDockerCompose(projectName, [
                "down",
                "--volumes",
                "--remove-orphans",
            ]);
        } catch (error) {
            console.warn(`[${projectName}] Failed to stop compose project: ${describeError(error)}`);
            return {
                stdout: "",
                stderr: "",
            };
        }
    }

    private createIdleTimeout(sessionID : string) {
        return setTimeout(() => {
            let session = this.sessionList[sessionID];
            console.log(`[${session?.projectName ?? sessionID}] Idle timeout reached`);
            this.stopInstance(sessionID).catch((error) => {
                console.error(`[${session?.projectName ?? sessionID}] Failed to stop on idle timeout: ${describeError(error)}`);
            });
        }, sessionIdleTimeout * 1000);
    }
}

// Arcane enforces a password policy (>= 12 chars, upper + lower + digit +
// symbol). Draw from each class explicitly instead of hoping a random string
// happens to satisfy it. Ambiguous glyphs (0/O, 1/l/I) are excluded because the
// password is shown on screen for the user to type.
const passwordUpper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const passwordLower = "abcdefghijkmnopqrstuvwxyz";
const passwordDigits = "23456789";
const passwordSymbols = "!@#$%^&*?+=_-";

/**
 * Pick `count` characters uniformly from `charset`.
 * @param charset Characters to pick from
 * @param count How many to pick
 */
function randomChars(charset : string, count : number) {
    let out : string[] = [];

    for (let i = 0; i < count; i++) {
        out.push(charset[crypto.randomInt(charset.length)]);
    }

    return out;
}

/** Generate a 14 character password that always satisfies Arcane's policy. */
export function generatePassword() {
    let chars = [
        ...randomChars(passwordUpper, 3),
        ...randomChars(passwordLower, 6),
        ...randomChars(passwordDigits, 3),
        ...randomChars(passwordSymbols, 2),
    ];

    // Fisher-Yates, so the class layout is not fixed.
    for (let i = chars.length - 1; i > 0; i--) {
        let j = crypto.randomInt(i + 1);
        [ chars[i], chars[j] ] = [ chars[j], chars[i] ];
    }

    return chars.join("");
}

interface ComposePsEntry {
    ID?: string;
    Name?: string;
    Service?: string;
    State?: string;
}

/**
 * Parse `docker compose ps --format json`, which emits a JSON array on compose
 * >= 2.21 and newline-delimited objects before that.
 * @param stdout Raw command output
 */
export function parseComposePs(stdout : string) : ComposePsEntry[] {
    let trimmed = stdout.trim();

    if (!trimmed) {
        return [];
    }

    if (trimmed.startsWith("[")) {
        let parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
    }

    return trimmed
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.startsWith("{"))
        .map(line => JSON.parse(line));
}
