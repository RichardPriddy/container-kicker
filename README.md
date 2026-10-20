# Container Kicker

A mobile-friendly dashboard for Docker **Swarm**: view services grouped by
stack or by node, see live task state, tail logs, and restart a service
either as a rolling update or a hard scale-to-0-and-back — all behind
Authentik OIDC login.

This talks to Swarm's cluster-level API (services/tasks/nodes), not
individual containers, so it must run on a **manager** node.

🤖 Built entirely by Claude, an AI assistant made by Anthropic. 

---

## Table of contents

- [Built entirely by Claude](#-built-entirely-by-claude)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
  - [1. Set up Authentik](#1-set-up-authentik)
  - [2. Create the Docker secrets](#2-create-the-docker-secrets)
  - [3. Build the image](#3-build-the-image)
  - [4. Deploy to your Swarm](#4-deploy-to-your-swarm)
  - [5. Updating](#5-updating)
- [Example docker-compose file](#example-docker-compose-file)
- [Configuration reference](#configuration-reference)
- [Using Docker secrets](#using-docker-secrets)
- [Restarting services: rolling vs hard](#restarting-services-rolling-vs-hard)
- [Security](#security)
- [HTTP API](#http-api)
- [Project structure](#project-structure)
- [Running locally without Swarm](#running-locally-without-swarm)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)

---

## 🤖 Built entirely by Claude

**Every part of this project was written by [Claude](https://www.anthropic.com/claude), an AI assistant made by Anthropic**, in a single conversation with the maintainer. That includes:

- the Node.js backend and Swarm API integration
- the OIDC / Authentik authentication flow and Docker-secrets handling
- the front-end (HTML, CSS and JavaScript)
- the logo and favicon set
- this README

The maintainer described what they wanted, ran the result on their own Swarm cluster, and reported back what broke or felt wrong. Claude then diagnosed and fixed the problems. Examples include a log-streaming bug, a task filter that wrongly hid long-running containers, a task-sorting quirk, and a reverse-proxy network misconfiguration.

What that means for you:

- **Claude could not test against a real Swarm cluster or a live Authentik instance.** It verified the code with syntax checks and with mocked Docker responses. Everything involving the real Docker daemon and real identity provider was exercised only by the maintainer, in their own environment.
- **It has not had a formal security review.** Read the [Security](#security) section and review the code yourself before exposing this to anything you care about. It mounts the Docker socket, so treat it accordingly.
- Issues and pull requests are welcome, from humans and AI assistants alike.

---

## What it does

Container Kicker answers one question: *"something's stuck, and I want to restart it without SSHing into a node."*

| Feature | Details |
|---|---|
| **Service overview** | Lists every Swarm service with live running/desired replica counts. Refreshes automatically every 5 seconds. |
| **Group by stack** | Services rolled up under their `com.docker.stack.namespace` label. |
| **Group by node** | Each node lists the tasks (container instances) currently scheduled on it, with node role and leader marker. |
| **Filter** | Instant text filter on service name or image. |
| **Task history** | Selecting a service shows its tasks with node, state and timestamp. Past attempts (shutdown, rejected, failed) older than 7 days are hidden. Tasks Swarm still wants running are always shown, however long they've been up. Newest and active tasks sort first. |
| **Failure reasons** | Click any task that has detail to expand Swarm's message, error text and container exit code. |
| **Logs** | Tails the last 200 lines of the selected service's logs and polls for new lines every 3 seconds, with autoscroll. |
| **Rolling restart** | Forces Swarm to redeploy the service's tasks using the service's own update policy (the equivalent of `docker service update --force`). |
| **Hard restart** | Scales the service to 0, waits for the tasks to stop, then scales back to the original replica count. |
| **Live restart output** | Both restart types stream CLI-style progress (spec fetched, scaled down, per-task state transitions) to an on-screen console as it happens. |
| **Authentik SSO** | OpenID Connect login via Authentik (any standards-compliant OIDC provider should work). |
| **Docker secrets** | Any sensitive setting can be supplied as `NAME_FILE=/run/secrets/...`. |
| **Mobile friendly** | Responsive layout. The detail panel is a side drawer on desktop and a full-screen view on phones. |

---

## How it works

```
 Browser ──HTTPS──▶ Reverse proxy (Traefik / Caddy / nginx)
                         │
                         ▼
              ┌─────────────────────┐        OIDC         ┌───────────┐
              │   Container Kicker  │◀──────────────────▶│ Authentik │
              │  (Node.js, Express) │                     └───────────┘
              └─────────┬───────────┘
                        │  /var/run/docker.sock
                        ▼
              Swarm manager's Docker Engine API
              (services · tasks · nodes · service logs)
```

Container Kicker talks to Swarm's **cluster-level** API (services, tasks and nodes), not to individual containers. That has two consequences:

1. **It must run on a manager node.** Only managers can serve the services/tasks/nodes API. The stack file pins it with `node.role == manager`.
2. **Logs are per service, not per replica.** Swarm aggregates a service's logs across all replicas through the manager. There is no supported way to pull a single replica's stream without direct access to the node it landed on, so the log viewer shows the combined output.

Plain containers started with `docker run` (outside Swarm) are **not** shown, because they aren't services.

---

## Requirements

- A Docker **Swarm** (a single-node swarm is fine: `docker swarm init`)
- Somewhere to build the image: a manager node, or CI plus a registry
- An **Authentik** instance (or another OIDC provider) for login
- A reverse proxy providing HTTPS (strongly recommended; see [Security](#security))

---

## Quick start

### 1. Set up Authentik

In Authentik, create an **OAuth2/OpenID Provider** and an **Application** that uses it:

| Setting | Value |
|---|---|
| Client type | **Confidential** |
| Redirect URI (strict) | `https://<your-public-url>/auth/callback` |
| Scopes | `openid`, `profile`, `email` |

Keep hold of three values:

- the **Client ID**
- the **Client Secret**
- the provider's **issuer URL**, usually `https://auth.example.com/application/o/<application-slug>/`. Copy it exactly as Authentik shows it (it normally ends with a slash). Discovery is read from `<issuer>/.well-known/openid-configuration`.

To control **who** can use the dashboard, restrict the Authentik application with a group or policy binding. See [Security](#security) for why this matters.

> **Tip:** `public/assets/icons/icon-512.png` is a ready-made icon. Upload it under *Applications → your application → Icon* so it shows up on the Authentik dashboard.

### 2. Create the Docker secrets

Run these on a manager node. Use `printf` rather than `echo` so no trailing newline ends up in the secret (the app trims whitespace anyway, but it keeps things tidy).

```bash
printf '%s' 'YOUR_AUTHENTIK_CLIENT_ID'     | docker secret create oidc_client_id -
printf '%s' 'YOUR_AUTHENTIK_CLIENT_SECRET' | docker secret create oidc_client_secret -
openssl rand -hex 32                       | docker secret create session_secret -
```

If you prefer to keep secrets as files alongside your stack definitions, Compose's `file:` form works too. See [Using Docker secrets](#using-docker-secrets).

### 3. Build the image

`docker stack deploy` **never builds images**. It ignores `build:` and only pulls or uses an existing `image:`. So build first.

**Option A: build on the manager and pin the service to it** (simplest, no registry)

```bash
git clone https://github.com/richardpriddy/container-kicker.git
cd container-kicker
docker build -t container-kicker:latest .
```

Because the image only exists on that node, add a placement constraint so Swarm schedules the service there:

```yaml
deploy:
  placement:
    constraints:
      - node.role == manager
      - node.hostname == <the-node-you-built-on>
```

**Option B: push to a registry** (recommended once you have more than one manager)

```bash
docker build -t registry.example.com/container-kicker:latest .
docker push  registry.example.com/container-kicker:latest
```

Then use that image name in your compose file, drop the `node.hostname` constraint (keep `node.role == manager`), and deploy with `--with-registry-auth` if the registry is private.

The image is based on `node:20-alpine`. Dependencies are installed with `npm install --omit=dev`, and the app listens on port **8088**.

### 4. Deploy to your Swarm

Edit [`docker-compose.yml`](docker-compose.yml) (or use your own; see the [example section](#example-docker-compose-file) below), then:

```bash
docker stack deploy -c docker-compose.yml container-kicker
```

Check it came up:

```bash
docker stack services container-kicker
docker service logs -f container-kicker_container-kicker
```

A healthy start logs something like:

```
Swarm dashboard listening on :8088 (auth: OIDC via Authentik)
```

Then browse to your `PUBLIC_URL`. You'll be redirected to Authentik to sign in.

A `GET /health` endpoint returns `{"ok":true}` without authentication, handy for load-balancer or uptime checks.

### 5. Updating

After pulling new code, rebuild the image and force the service to redeploy. The service name is `<stack>_<service>`; check it with `docker stack services <stack>`.

**Local image (Option A):**

```bash
docker build -t container-kicker:latest .
docker service update --force container-kicker_container-kicker
```

**Registry image (Option B):**

```bash
docker build -t registry.example.com/container-kicker:latest .
docker push  registry.example.com/container-kicker:latest
docker service update --force --with-registry-auth \
  --image registry.example.com/container-kicker:latest container-kicker_container-kicker
```

(With a registry image, Swarm pins the image digest at deploy time, which is why `--image` is needed to pick up the new build.)

---

## Example docker-compose file

```yaml
################################################################  
# Container Kicker - A service to allow easy restarting of
#                    services
################################################################  
services:
  app:
    image: container-kicker:latest
    env_file:
      - $var_docker_config/.env
      - .env
    environment:
      OIDC_ISSUER: https://auth.$var_domain/application/o/container-kicker/
      PUBLIC_URL: "https://container-kicker.$var_domain"
    secrets:
      - oidc_client_id
      - oidc_client_secret
      - session_secret
    user: $PUID:$PGID
    networks:
      - swarm_public_network
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
          - node.hostname == node-0 #Currently this is where I'm building the image.
      restart_policy:
        condition: on-failure
        delay: 5s
      labels:
        - "traefik.enable=true"
        - "traefik.swarm.network=swarm_public_network"
        - "traefik.http.routers.containerkicker.entrypoints=websecure-internal"
        - "traefik.http.routers.containerkicker.rule=Host(`container-kicker.$var_domain`)"
        - "traefik.http.routers.containerkicker.middlewares=chain-no-auth-no-rate-limit@file"
        - "traefik.http.services.containerkicker.loadbalancer.server.port=8088"
    
networks:
  swarm_public_network:
    external: true

secrets:
  oidc_client_id:
    file: $var_docker_config/.secrets/container_kicker_oidc_client_id.secret
  oidc_client_secret:
    file: $var_docker_config/.secrets/container_kicker_oidc_client_secret.secret
  session_secret:
    file: $var_docker_config/.secrets/container_kicker_session_secret.secret
```

A minimal, generic reference is also included in the repo as [`docker-compose.yml`](docker-compose.yml).

---

## Configuration reference

All configuration is via environment variables. Variables marked 🔐 are sensitive and support the [`_FILE` convention](#using-docker-secrets).

| Variable | Required | Default | Description |
|---|---|---|---|
| `OIDC_ISSUER` | for auth | none | Authentik issuer URL (with trailing slash). Discovery is fetched from `<issuer>/.well-known/openid-configuration` at startup. |
| `OIDC_CLIENT_ID` 🔐 | for auth | none | OAuth2 client ID. |
| `OIDC_CLIENT_SECRET` 🔐 | for auth | none | OAuth2 client secret. |
| `PUBLIC_URL` | when auth is on | none | The external URL users reach the dashboard at, e.g. `https://kicker.example.com`. Used to build the callback URL Authentik redirects to. The app refuses to start without it when OIDC is configured. |
| `OIDC_CALLBACK_PATH` | no | `/auth/callback` | Path appended to `PUBLIC_URL` for the redirect URI. |
| `SESSION_SECRET` 🔐 | recommended | random per start | Signs session cookies. If unset, a random one is generated, so everyone is logged out on every restart. |
| `COOKIE_SECURE` | no | `false` | Set to `true` when served over HTTPS so the session cookie is only sent over TLS. |
| `TRUST_PROXY` | no | `false` | Set to `true` when behind a reverse proxy that terminates TLS (needed for secure cookies to work). |
| `PORT` | no | `8088` | Port the app listens on inside the container. |
| `DOCKER_SOCKET` | no | `/var/run/docker.sock` | Path to the Docker socket inside the container. |

> ⚠️ **If `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are not all set, the app starts with NO authentication** and logs a warning. That is meant for local testing only. Never deploy it that way on anything reachable by others.

---

## Using Docker secrets

For every sensitive setting there are two equivalent ways to supply it:

```yaml
# Plain env var
OIDC_CLIENT_SECRET: "s3cret"

# Docker-secret style: the app reads the value from the file
OIDC_CLIENT_SECRET_FILE: /run/secrets/oidc_client_secret
```

If `NAME_FILE` is set, the file is read (and whitespace-trimmed) and takes priority over `NAME`. If the file can't be read, the app **fails loudly at startup** rather than silently carrying on with an empty value.

This applies to `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `SESSION_SECRET`. Swarm mounts secrets at `/run/secrets/<secret-name>`.

Two ways to define the secrets in your stack file:

```yaml
# 1) External secrets created beforehand with `docker secret create`
secrets:
  oidc_client_id:
    external: true

# 2) File-based secrets, read from disk when the stack is deployed
secrets:
  oidc_client_id:
    file: ./.secrets/oidc_client_id.secret
```

Both work with `docker stack deploy`. Keep any secret files out of version control (add them to `.gitignore`).

---

## Restarting services: rolling vs hard

Both are available from the service's detail panel. Progress streams live into an on-screen console.

### Rolling restart (default choice)

Increments the service's internal `ForceUpdate` counter, which makes Swarm redeploy its tasks following the service's own `update_config` (order, parallelism, delay, health checks). It is the same as:

```bash
docker service update --force <service>
```

Whether this is zero-downtime depends on the service's update policy. With `order: start-first` and a health check, it typically is. With the default `stop-first`, expect a brief gap per replica.

### Hard restart (scale to 0 → N)

1. Reads the current replica count (*N*)
2. Scales the service to **0**
3. Waits up to 25 seconds for running tasks to stop (it carries on regardless if they don't)
4. Scales back to *N*
5. Watches the new tasks until they're all running (up to 30 seconds)

This **will** cause downtime for that service. Use it when a service is wedged and a rolling update doesn't clear it. It only works for **replicated** services, not `global` mode.

---

## Security

**Read this before deploying.**

- **The Docker socket is root-equivalent.** Anything that can talk to `/var/run/docker.sock` can start privileged containers with host mounts. Container Kicker needs it to manage services, so treat access to the dashboard as equivalent to root on your cluster.
- **Authentication is not authorisation.** Any user who can log in via Authentik can restart *any* service the dashboard can see, including Authentik itself, your reverse proxy, and the dashboard. Restrict who can sign in with Authentik group or policy bindings on the application.
- **Don't expose it unauthenticated.** With no OIDC variables set, the app runs wide open.
- **Use HTTPS.** Put it behind a TLS-terminating reverse proxy, then set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
- **Consider a socket proxy.** For tighter scoping, run something like [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) in front of the real socket and allow only the API calls this app needs, rather than mounting the raw socket. The app reads the socket path from `DOCKER_SOCKET`, which makes this straightforward.
- **Sessions** are httpOnly cookies that expire after 8 hours. Sign out at `/logout`.
- **No audit log.** Restart actions are written to the container's stdout on failure but are not recorded per user. Add one if you need it.
- **Secrets hygiene.** Use Docker secrets, not plain environment variables, for the client secret and session secret.
- **AI-written code.** See [Built entirely by Claude](#-built-entirely-by-claude). Review it before trusting it with production infrastructure.

---

## HTTP API

The UI is a thin client over a small JSON API. All `/api/*` routes require an authenticated session (unless auth is disabled) and return `401` otherwise.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check. No authentication. |
| `GET` | `/favicon.ico` | Favicon. No authentication. |
| `GET` | `/api/whoami` | Whether auth is enabled and who is signed in. |
| `GET` | `/api/overview` | Swarm status plus all nodes, services and tasks in one call. |
| `POST` | `/api/services/:id/force-restart` | Rolling restart. Streams plain-text progress. |
| `POST` | `/api/services/:id/hard-restart` | Scale to 0 then back. Streams plain-text progress. |
| `GET` | `/api/services/:id/logs?tail=200&since=<unix-seconds>` | Recent log lines (`tail` is capped at 2000). |

The two restart endpoints return **chunked `text/plain`**, not JSON. Lines are written as they happen. Success lines start with `✔` and a failure produces a final line starting with `✖`.

Auth routes: `GET /login`, `GET /auth/callback` (or your `OIDC_CALLBACK_PATH`), `GET /logout`.

---

## Project structure

```
container-kicker/
├── server.js                  # Express app: sessions, routes, streaming restart endpoints
├── lib/
│   ├── auth.js                # Authentik / OIDC login (passport-openidconnect + discovery)
│   ├── docker.js              # Swarm API wrapper: nodes, services, tasks, restarts, logs
│   └── secrets.js             # NAME / NAME_FILE secret reader
├── public/
│   ├── index.html             # UI shell
│   └── assets/
│       ├── app.js             # UI logic (grouping, detail panel, logs, restart console)
│       ├── style.css          # Responsive styling
│       └── icons/             # Logo, favicon set, Authentik icon (icon-512.png)
├── Dockerfile                 # node:20-alpine image
├── docker-compose.yml         # Reference Swarm stack file
├── .env.example               # Variables for local, non-Swarm testing
└── package.json
```

Dependencies: [`express`](https://expressjs.com/), [`express-session`](https://github.com/expressjs/session), [`dockerode`](https://github.com/apocas/dockerode), [`passport`](https://www.passportjs.org/) and [`passport-openidconnect`](https://github.com/jaredhanson/passport-openidconnect). The front-end has no build step and no framework.

---

## Running locally without Swarm

You can start it without a Swarm or Authentik to poke at the code:

```bash
npm install
node server.js          # no OIDC_* set, so authentication is disabled
```

Open <http://localhost:8088>. Without a Swarm, the status line will say *"swarm inactive on this node"*. To see real data, run `docker swarm init` on your local Docker engine and create a test service or two.

To try the `NAME_FILE` secrets mechanism locally:

```bash
cp .env.example .env    # edit values, or switch to *_FILE variables
```

---

## Troubleshooting

**Gateway Timeout / 504 from the reverse proxy, but the logs say it's listening**
The proxy can't reach the container. The service and the proxy must share a Docker overlay network. Labels such as `traefik.swarm.network=...` only choose *which* shared network to use. They don't attach the service to it. Add the proxy's network under the service's `networks:` and declare it `external: true` at the top level.

**Redirected to Authentik, then "redirect URI mismatch"**
The redirect URI configured in Authentik must exactly match `PUBLIC_URL` + `OIDC_CALLBACK_PATH`, including the scheme (`https://`) and no trailing slash. Check both sides.

**Container exits with "PUBLIC_URL must be set…"**
`PUBLIC_URL` is required whenever OIDC is configured.

**Container exits with "OIDC discovery request … failed"**
The container can't reach `OIDC_ISSUER`, or the issuer URL is wrong. Test from inside the Swarm network: `<issuer>/.well-known/openid-configuration` should return JSON.

**Container exits with "Could not read secret for … from …_FILE=…"**
The secret isn't mounted at that path. Check that it's listed under the service's `secrets:` and that the `_FILE` path matches `/run/secrets/<name>`.

**Everyone gets logged out after a restart**
`SESSION_SECRET` isn't set, so a new random secret is generated on each start. Provide a stable one via a Docker secret.

**Login loops or the session cookie isn't kept**
Behind a TLS-terminating proxy you need `TRUST_PROXY=true`, plus `COOKIE_SECURE=true` if you're serving HTTPS.

**"swarm inactive on this node" or "worker, not a manager"**
Run the service on a manager node and mount that node's Docker socket. Check the `node.role == manager` placement constraint.

**"No tasks in the last 7 days" for a service that is clearly running**
Make sure you're on a current build. Early versions filtered by task age and wrongly hid long-running tasks.

**Logs are empty or an error is shown**
The service may use a logging driver that doesn't support reading logs back (for example `none`, or a remote-only driver). Swarm can only serve logs for drivers that support it.

---

## Known limitations

- **Sessions are stored in memory.** They're lost on restart and aren't shared between replicas, so run a single replica. Swap in a persistent session store if you need more.
- **Logs are service-wide**, not per replica (a Swarm limitation, explained above).
- **Log lines are polled**, not streamed. New lines can lag by up to 3 seconds.
- **One-week task history window** is fixed in the front-end (`ONE_WEEK_MS` in `public/assets/app.js`). There's no UI toggle.
- **Global-mode services** can't be hard-restarted (there's no replica count to scale).
- **No per-user permissions or audit trail.** Anyone who passes Authentik can restart anything.
- **Swarm only.** Standalone containers and plain Compose projects aren't shown.
- **Not load-tested.** It's designed for a homelab or small cluster dashboard.

---

## Contributing

Issues and pull requests are welcome. When contributing:

- keep the dependency list small; the project is deliberately lightweight
- test against a real Swarm if you touch `lib/docker.js` or the restart logic
- don't commit secrets (use `.env` and `*.secret` files locally and keep them gitignored)

AI-assisted contributions are fine, but please say so in the PR description, in keeping with how this project was made.

---