# Demo Arcane

Create a demo site for your Docker based web application.

Live Demo (Arcane):
https://demo.getarcane.app/start-demo

![image](https://github.com/louislam/demo-kuma/assets/1336778/f15b5e46-5c98-419e-98e4-a2d52b91780c)


## Features

- Quickly create a demo for your project.
- Spin up a temporary Arcane demo when requested, then shut it down automatically.
- A countdown timer at the bottom right corner.
- 10 minute demo sessions by default.
- Portless demo instances design in v2, you just need one port for Demo Kuma.

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
1. If you are running behind a public domain, set `APP_URL` to the public origin before starting the stack.
1. Go to http://localhost:3003/start-demo to test the demo.

# More screenshots

![image](https://github.com/louislam/demo-kuma/assets/1336778/c264c86a-0718-42af-a91b-20db061af7db)
