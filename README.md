# Demo Arcane

Create a demo site for your Docker based web application.

Live Demo (Arcane):
https://demo.getarcane.app/start-demo

![image](https://github.com/louislam/demo-kuma/assets/1336778/f15b5e46-5c98-419e-98e4-a2d52b91780c)


## Features

- Quickly create a demo for your project.
- Spin up an isolated Arcane stack when requested, then shut it down automatically when time is up.
- A countdown timer at the bottom right corner.
- Custom demo duration.
- Portless demo instances design in v2, you just need one port for Demo Kuma.
- Each session gets its own `docker:29-dind` daemon and Docker socket proxy instead of direct host socket access.
- Each session rotates Arcane's default admin into a unique random username/password before handing the demo to the user.

## How to use

1. Create a stack directory `demo-kuma`.
1. Download `compose.yaml` and `compose-demo.yaml` into the directory.
  - `compose.yaml` = Demo Kuma stack
     - You should go through all variables in the `environment:` section.
  - `compose-demo.yaml` = The stack that you want to provide a demo (Arcane)
     - By default, the main service should be `main`.
     - If you run the stack with a different project name, set `DOCKER_NETWORK_NAME` to match that network (e.g., `{project}_default`).
1. Start the stack:
    ```bash
    docker compose up -d --build
    ```
    On first boot, Demo Kuma will generate `ENCRYPTION_KEY` and `JWT_SECRET` with `openssl rand -base64 32` automatically and persist them in `/app/runtime`.
    If you want to provide your own values instead, you can still set `ENCRYPTION_KEY` and `JWT_SECRET` in `.env`.
1. Go to http://localhost:3003/start-demo to test the demo.

## Arcane demo behavior

- The default session lifetime is 10 minutes (`SESSION_TIME=600`).
- Sessions are torn down early if the browser page disappears.
  The page sends a best-effort close signal immediately, and the server also expires sessions after a short missed-heartbeat window (`SESSION_IDLE_TIMEOUT=30`).
- Set `APP_URL` to the public URL of the demo site in production, for example `https://demo.getarcane.app`.
- Each session starts three containers inside the demo stack:
  - `dind`: isolated Docker daemon (`docker:29-dind`)
  - `docker-socket-proxy`: restricted proxy in front of that daemon
  - `main`: Arcane, configured to use the proxy via `DOCKER_HOST=tcp://docker-socket-proxy:2375`
- After Arcane is healthy, the demo service runs `scripts/bootstrap-arcane-instance.mjs` to:
  - sign in with Arcane's initial default admin
  - change the password to a random per-session value
  - rename the admin username to a random per-session value
- The generated credentials are shown in the demo UI next to the countdown timer.

## How it works?

1. Demo Kuma takes control of your Docker
1. User requests a demo via a browser
1. Demo Kuma assigns a session ID for this request and spins up the stack in `compose-demo.yaml`
1. The stack starts a fresh Arcane instance, a dedicated `docker:29-dind` daemon, and a Docker socket proxy for that session only
1. Once Arcane is healthy, Demo Kuma bootstraps a random username/password for that session
1. Demo Kuma acts as a reverse proxy to communicate between the browser and the demo stack
1. When time is up, Demo Kuma shuts the whole stack down and removes its volumes

# More screenshots

![image](https://github.com/louislam/demo-kuma/assets/1336778/c264c86a-0718-42af-a91b-20db061af7db)
