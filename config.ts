function readNumberEnv(value : string | undefined, fallback : number) {
    if (!value) {
        return fallback;
    }

    let parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

export const serverPort = readNumberEnv(process.env.SERVER_PORT, 80);
export const stackPrefix = process.env.STACK_PREFIX || "demo";
export const serviceName = process.env.STACK_MAIN_SERVICE_NAME || "main";
export const servicePort = readNumberEnv(process.env.STACK_MAIN_SERVICE_PORT, 80);
export const entryPath = process.env.STACK_MAIN_SERVICE_ENTRY_PATH || "/";
export const healthPath = process.env.STACK_HEALTH_PATH || entryPath;
export const dockerNetwork = process.env.DOCKER_NETWORK_NAME || "demo-kuma";
export const websiteName = process.env.WEBSITE_NAME || "Demo";
export const sessionTime = readNumberEnv(process.env.SESSION_TIME, 600);
export const sessionIdleTimeout = readNumberEnv(process.env.SESSION_IDLE_TIMEOUT, 30);
export const startTimeout = readNumberEnv(process.env.START_TIMEOUT, 60);
export const installURL = process.env.INSTALL_URL;
export const showEntry = (process.env.SHOW_ENTRY === "true");
