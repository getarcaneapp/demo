/**
 * Read a positive integer from the environment.
 * Throws on anything that is present but not a positive integer, so a typo in
 * compose.yaml fails loudly at boot instead of silently falling back.
 * @param name Environment variable name (used in error messages)
 * @param value Raw environment value
 * @param fallback Value used when the variable is unset or empty
 */
function readNumberEnv(name : string, value : string | undefined, fallback : number) {
    if (value === undefined || value.trim() === "") {
        return fallback;
    }

    let parsed = Number.parseInt(value.trim(), 10);

    if (Number.isNaN(parsed)) {
        throw new Error(`Invalid config: ${name} must be an integer, got "${value}"`);
    }

    if (parsed <= 0) {
        throw new Error(`Invalid config: ${name} must be greater than 0, got ${parsed}`);
    }

    return parsed;
}

/**
 * Read a boolean from the environment ("true"/"1" are truthy).
 * @param value Raw environment value
 * @param fallback Value used when the variable is unset or empty
 */
function readBooleanEnv(value : string | undefined, fallback : boolean) {
    if (value === undefined || value.trim() === "") {
        return fallback;
    }

    let normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}

export const serverPort = readNumberEnv("SERVER_PORT", process.env.SERVER_PORT, 80);

if (serverPort > 65535) {
    throw new Error(`Invalid config: SERVER_PORT must be <= 65535, got ${serverPort}`);
}

export const stackPrefix = process.env.STACK_PREFIX || "demo";
export const serviceName = process.env.STACK_MAIN_SERVICE_NAME || "main";
export const servicePort = readNumberEnv("STACK_MAIN_SERVICE_PORT", process.env.STACK_MAIN_SERVICE_PORT, 80);
export const entryPath = process.env.STACK_MAIN_SERVICE_ENTRY_PATH || "/";
export const healthPath = process.env.STACK_HEALTH_PATH || entryPath;
export const dockerNetwork = process.env.DOCKER_NETWORK_NAME || "demo-kuma";
export const websiteName = process.env.WEBSITE_NAME || "Demo";
export const sessionTime = readNumberEnv("SESSION_TIME", process.env.SESSION_TIME, 600);

/**
 * Seconds without a heartbeat / proxied request before a session is torn down.
 * Must stay comfortably above the client heartbeat interval: browsers throttle
 * background-tab timers to roughly one tick per minute, so a short window kills
 * sessions of users who simply switched tabs.
 */
export const sessionIdleTimeout = readNumberEnv("SESSION_IDLE_TIMEOUT", process.env.SESSION_IDLE_TIMEOUT, 120);

export const startTimeout = readNumberEnv("START_TIMEOUT", process.env.START_TIMEOUT, 60);
export const bootstrapTimeout = readNumberEnv("BOOTSTRAP_TIMEOUT", process.env.BOOTSTRAP_TIMEOUT, 30);
export const installURL = process.env.INSTALL_URL;
export const showEntry = (process.env.SHOW_ENTRY === "true");
export const appURL = process.env.APP_URL || "";

/** Maximum number of concurrent demo stacks (including ones still starting). */
export const maxSessions = readNumberEnv("MAX_SESSIONS", process.env.MAX_SESSIONS, 10);

/** Per-IP start-instance rate limit. */
export const startRateLimitMax = readNumberEnv("START_RATE_LIMIT_MAX", process.env.START_RATE_LIMIT_MAX, 2);
export const startRateLimitWindow = readNumberEnv("START_RATE_LIMIT_WINDOW", process.env.START_RATE_LIMIT_WINDOW, 600);

/** Interval (seconds) of the sweep that kills sessions whose Arcane container died. */
export const healthSweepInterval = readNumberEnv("HEALTH_SWEEP_INTERVAL", process.env.HEALTH_SWEEP_INTERVAL, 60);

/** Consecutive failed health probes before a session is considered dead. */
export const healthSweepFailureLimit = readNumberEnv("HEALTH_SWEEP_FAILURE_LIMIT", process.env.HEALTH_SWEEP_FAILURE_LIMIT, 2);

/**
 * Trust X-Forwarded-For for client IP (rate limiting).
 * Only enable when this server sits behind a reverse proxy / tunnel you control,
 * otherwise clients can spoof the header and bypass the rate limit.
 */
export const trustProxy = readBooleanEnv(process.env.TRUST_PROXY, false);
