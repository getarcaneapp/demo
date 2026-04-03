import childProcessAsync from "promisify-child-process";
import { sleep } from "./util";
import crypto from "crypto";
import {
    sessionTime,
    sessionIdleTimeout,
    stackPrefix,
    startTimeout,
    servicePort,
    healthPath,
    dockerNetwork,
    serviceName,
} from "./config";

interface SessionCredentials {
    username: string;
    password: string;
}

interface SessionInfo {
    baseURL: string;
    endSessionTime: number;
    credentials: SessionCredentials;
    timeout: NodeJS.Timeout;
    idleTimeout: NodeJS.Timeout;
}

export class Pool {
    /**
     * sessionList[sessionID] = session metadata
     */
    sessionList: Record<string, SessionInfo> = {};

    async startInstance() {
        let sessionID : string = "";

        while (true) {
            sessionID = crypto.randomUUID().substring(0, 8);
            if (this.sessionList[sessionID] === undefined) {
                break;
            }
        }

        let timeout : NodeJS.Timeout;
        let idleTimeout : NodeJS.Timeout;
        let credentials = this.generateCredentials(sessionID);

        console.log(`[${sessionID}] Start a session`);

        try {
            await this.runDockerCompose(sessionID, [
                "up",
                "-d",
            ]);

            let startStackTime = Date.now();
            let baseURL = "";

            // Wait until the service is opened
            while (true) {
                try {
                    let ip = await this.getServiceIP(sessionID);
                    baseURL = `http://${ip}:${servicePort}`;
                    let entryURL = baseURL + healthPath;

                    console.log("Checking entry: " + entryURL);

                    let res = await fetch(entryURL);
                    await res.text();

                    if (res.status === 200) {
                        break;
                    }
                } catch (e) {
                }

                await sleep(2000);
                if (Date.now() - startStackTime > startTimeout * 1000) {
                    throw new Error("Start instance timeout");
                }
            }

            await this.bootstrapArcaneInstance(baseURL, credentials);

            let endSessionTime = Date.now() + sessionTime * 1000;

            // Timer for closing the session
            timeout = setTimeout(async () => {
                console.log(`[${sessionID}] Time's up`);
                await this.stopInstance(sessionID);
            }, (sessionTime) * 1000);

            idleTimeout = this.createIdleTimeout(sessionID);

            this.sessionList[sessionID] = {
                baseURL,
                endSessionTime,
                credentials,
                timeout,
                idleTimeout,
            };
            console.log(`[${sessionID}] Session started`);

            return {
                sessionID,
                endSessionTime,
                credentials,
            };
        } catch (error) {
            await this.stopComposeProject(sessionID);
            throw error;
        }
    }

    async stopInstance(sessionID : string) {
        let session = this.sessionList[sessionID];

        if (session?.timeout) {
            clearTimeout(session.timeout);
        }

        if (session?.idleTimeout) {
            clearTimeout(session.idleTimeout);
        }

        await this.stopComposeProject(sessionID);
        delete this.sessionList[sessionID];
    }

    getServiceURL(sessionID : string) : string | undefined {
        return this.sessionList[sessionID]?.baseURL;
    }

    getSession(sessionID : string) {
        return this.sessionList[sessionID];
    }

    touchSession(sessionID : string) {
        let session = this.sessionList[sessionID];

        if (!session) {
            return false;
        }

        clearTimeout(session.idleTimeout);
        session.idleTimeout = this.createIdleTimeout(sessionID);
        return true;
    }

    async getServiceIP(sessionID : string) : Promise<string> {
        let response = await childProcessAsync.spawn("docker", [
            "inspect",
            `${stackPrefix}-${sessionID}-${serviceName}-1`,
        ], {
            encoding: "utf-8",
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

        let networks = obj.NetworkSettings.Networks;

        if (!networks) {
            throw new Error("No networks");
        }

        // Find the target network
        let network = networks[dockerNetwork];

        if (!network) {
            throw new Error("Network not found");
        }

        let ip = network.IPAddress;

        if (!ip) {
            throw new Error("IP not found");
        }

        return ip;
    }

    async clearInstance() {
        let result = await childProcessAsync.spawn("docker", [
            "compose",
            "ls",
            "--format", "json",
        ], {
            encoding: "utf-8",
        });

        if (typeof result.stdout === "string") {
            let list = JSON.parse(result.stdout);
            for (let stack of list) {
                if (stack.Name?.startsWith(stackPrefix + "-")) {
                    console.log(`Clearing ${stack.Name}`);
                    let sessionID = stack.Name.replace(`${stackPrefix}-`, "");
                    let result = await this.stopComposeProject(sessionID);

                    console.log(result.stdout, result.stderr);
                }
            }
        }

        this.sessionList = {};
    }

    private generateCredentials(sessionID : string) : SessionCredentials {
        return {
            username: `demo-${sessionID}-${crypto.randomBytes(2).toString("hex")}`,
            password: `arc-${crypto.randomBytes(9).toString("base64url")}`,
        };
    }

    private async bootstrapArcaneInstance(baseURL : string, credentials : SessionCredentials) {
        await childProcessAsync.spawn("node", [
            "./scripts/bootstrap-arcane-instance.mjs",
            baseURL,
            credentials.username,
            credentials.password,
        ], {
            encoding: "utf-8",
        });
    }

    private async runDockerCompose(sessionID : string, args : string[]) {
        if (!process.env.ENCRYPTION_KEY || !process.env.JWT_SECRET) {
            throw new Error("ENCRYPTION_KEY and JWT_SECRET must be set");
        }

        return childProcessAsync.spawn("docker", [
            "compose",
            "--file", "compose-demo.yaml",
            "-p", `${stackPrefix}-${sessionID}`,
            ...args,
        ], {
            encoding: "utf-8",
            env: {
                ...process.env,
                DOCKER_NETWORK_NAME: dockerNetwork,
            },
        });
    }

    private async stopComposeProject(sessionID : string) {
        try {
            return await this.runDockerCompose(sessionID, [
                "down",
                "--volumes",
                "--remove-orphans",
            ]);
        } catch (error) {
            console.warn(`[${sessionID}] Failed to stop compose project`, error);
            return {
                stdout: "",
                stderr: "",
            };
        }
    }

    private createIdleTimeout(sessionID : string) {
        return setTimeout(async () => {
            console.log(`[${sessionID}] Idle timeout reached`);
            await this.stopInstance(sessionID);
        }, sessionIdleTimeout * 1000);
    }
}
