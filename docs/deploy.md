# Deployment

Jian is two published images that always ship at the same version:

- `ghcr.io/lucasaarch/jian-web` serves the panel and is the only address anyone needs. It passes `/v1/*`, `/health`, `/openapi.json` and `/jian-remote.mjs` on to the gateway, so the browser, channel webhooks, OAuth callbacks and remote workers all use one origin.
- `ghcr.io/lucasaarch/jian-gateway` is the API, the agents and the workers. It needs no public address of its own.

```text
browser, webhooks, workers ──▶ web :3000 ──▶ gateway :4310 ──▶ PostgreSQL
```

They run three ways. The first uses a clone of the repository; the other two use the same images, with the database in your hands. Migrations run by themselves when the gateway starts: there is no separate migration step, and a new version applies what is missing as it comes up.

Each image is a multi-architecture index with `linux/amd64` and `linux/arm64`, built on native runners with a provenance attestation attached. To check one before running:

```bash
gh attestation verify oci://ghcr.io/lucasaarch/jian-gateway:latest --repo lucasaarch/jian
gh attestation verify oci://ghcr.io/lucasaarch/jian-web:latest --repo lucasaarch/jian
```

## Way 1 — clone and Compose

Brings the web server, the gateway and PostgreSQL up together. This is the path for a single machine.

```bash
git clone https://github.com/lucasaarch/jian.git && cd jian
make setup
make up
```

`make setup` writes `.env` with mode `0600`, holding the host token, the database password and the encryption keyring; it never prints a secret. `make up` pulls missing images, waits for the database to be healthy, then starts the gateway, and the web server once the gateway is healthy. On an update, `make pull` fetches the new images first. `make logs` follows the log, `make ps` shows the state, and `make down` stops the stack without deleting the volume.

`compose.yaml` publishes the web server on `127.0.0.1:4310`, the port the gateway itself used before the panel became its own container, so the panel opens at `http://127.0.0.1:4310/` and every address handed out earlier keeps working. To reach it beyond localhost, put an HTTPS proxy in front and change the address with `JIAN_BIND_ADDRESS` and `JIAN_BIND_PORT`. Neither the gateway nor PostgreSQL publishes a port: each is reached only from the service in front of it, over the Compose network.

`JIAN_VERSION` pins the version of both images; without it, Compose uses `latest`. To run your own builds instead of the published images, uncomment both `build:` blocks in `compose.yaml` and use `docker compose up -d --build`.

`compose.dev.yaml` is a different thing: it brings up PostgreSQL alone, on `127.0.0.1:5432`, so `pnpm dev` can run on the machine. It has its own project name and volume, so the development database and the production one share nothing, even on the same host.

## Way 2 — the images on their own

With a PostgreSQL you already run, put both containers on one network and publish only the web server:

```bash
docker network create jian

docker run -d --name jian --network jian --restart unless-stopped \
  -e DATABASE_URL='postgres://user:password@db.internal:5432/jian' \
  -e JIAN_API_TOKEN="$JIAN_API_TOKEN" \
  -e JIAN_ACTIVE_KEY_ID=v1 \
  -e JIAN_MASTER_KEYS="$JIAN_MASTER_KEYS" \
  -e JIAN_TRUSTED_PROXIES=uniquelocal \
  -v jian_home:/home/node \
  ghcr.io/lucasaarch/jian-gateway:latest

docker run -d --name jian-web --network jian --restart unless-stopped \
  -p 127.0.0.1:4310:3000 \
  -e JIAN_GATEWAY_URL=http://jian:4310 \
  ghcr.io/lucasaarch/jian-web:latest
```

`JIAN_TRUSTED_PROXIES` lets the gateway believe the client address, scheme and host the web server forwards: the rate limits count per client, the panel cookie is marked `Secure` behind HTTPS, and channel webhook URLs carry the public host. Name only addresses that cannot be reached from outside; a gateway port that is also published to the internet must not trust `uniquelocal`.

The gateway image carries a health check against `/health`, and the web image one against its own `/web/health`; `docker ps` shows both. The process runs as the unprivileged `node` user, and the gateway itself writes nothing outside the database.

The image is also a workbench for that agent: Node, Python with `uv`, Go, `git`, `gh`, `ssh`, `curl`, `wget`, the text tools (`sed`, `awk`, `rg`, `jq`) and a C toolchain. The built-in `machine-tools` skill tells the agent what is there and how to add more. It installs per user and never as root — no `sudo`, no `apt` — so it works the same on a host that starts containers with `no-new-privileges`. Each profile works in its own workspace under `/home/node/workspaces`, which holds what it installs, its SSH keys and its Git and `gh` logins, confined by Landlock (see [security](security.md)); mount a volume on `/home/node` to keep them across updates. A system package it needs belongs in the image.

## Way 3 — Kubernetes

The same images, with the secrets in a `Secret`, the gateway internal to the cluster and only the web server behind the Ingress. Keep `replicas: 1` while a migration is pending: it runs at startup, and simultaneous replicas race for it. Once applied, more replicas are safe.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: jian
type: Opaque
stringData:
  DATABASE_URL: postgres://jian:change-me@postgres:5432/jian
  JIAN_API_TOKEN: replace-with-a-random-token-of-32-characters
  JIAN_ACTIVE_KEY_ID: v1
  JIAN_MASTER_KEYS: '{"v1":"replace-with-32-random-bytes-in-base64"}'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jian
spec:
  replicas: 1
  selector:
    matchLabels: { app: jian }
  template:
    metadata:
      labels: { app: jian }
    spec:
      containers:
        - name: gateway
          image: ghcr.io/lucasaarch/jian-gateway:0.1.0
          envFrom:
            - secretRef: { name: jian }
          env:
            - name: HOST
              value: 0.0.0.0
            # Pod addresses; only the web Deployment reaches this Service.
            - name: JIAN_TRUSTED_PROXIES
              value: uniquelocal
          ports:
            - containerPort: 4310
          readinessProbe:
            httpGet: { path: /health, port: 4310 }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health, port: 4310 }
            initialDelaySeconds: 30
            periodSeconds: 30
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
---
apiVersion: v1
kind: Service
metadata:
  name: jian
spec:
  selector: { app: jian }
  ports:
    - port: 4310
      targetPort: 4310
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jian-web
spec:
  replicas: 1
  selector:
    matchLabels: { app: jian-web }
  template:
    metadata:
      labels: { app: jian-web }
    spec:
      containers:
        - name: web
          image: ghcr.io/lucasaarch/jian-web:0.1.0
          env:
            - name: JIAN_GATEWAY_URL
              value: http://jian:4310
          ports:
            - containerPort: 3000
          readinessProbe:
            httpGet: { path: /web/health, port: 3000 }
            periodSeconds: 10
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
---
apiVersion: v1
kind: Service
metadata:
  name: jian-web
spec:
  selector: { app: jian-web }
  ports:
    - port: 80
      targetPort: 3000
```

Pin the same exact version on both images; with `latest`, any restart changes the code without warning. Expose `jian-web` through an Ingress with TLS, never a `Service` directly; the gateway's `Service` stays internal. The web server holds no state, so it scales freely.

An agent with the shell switch on works in its workspace under `/home/node/workspaces`. Mount a `PersistentVolumeClaim` on `/home/node` to keep what it installs across restarts.

`JIAN_ROLE=all` runs the API and the worker in one process. To split them, use two Deployments, `api` and `worker`, sharing the same database and the same keyring; only `api` gets the `Service` the web server calls.

## Environment variables

The gateway's:

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | The PostgreSQL connection. The process migrates the schema at startup. |
| `JIAN_API_TOKEN` | yes | — | The host token, at least 32 characters. It also signs the panel cookies. |
| `JIAN_ACTIVE_KEY_ID` | yes | — | The id of the keyring key used for new writes. |
| `JIAN_MASTER_KEYS` | yes | — | JSON mapping an id to a 32-byte key in Base64. Keep it out of the database backup. |
| `HOST` | no | `0.0.0.0` in the image | The listening address inside the container. |
| `PORT` | no | `4310` | The listening port; the health check follows it. |
| `JIAN_ROLE` | no | `all` | `all`, `api` or `worker`. |
| `JIAN_TIME_ZONE` | no | saved legacy value, then host zone | IANA zone for the agent's current time and new schedules, for example `America/Sao_Paulo`. Set the same value on API and worker replicas; it overrides but does not delete an older saved value. |
| `JIAN_ALLOW_PRIVATE_ORIGINS` | no | empty | Exact private origins allowed for outbound calls, for example `http://127.0.0.1:11434`. |
| `JIAN_CAVEMAN_ENABLED` | no | `false` | Set to `true` to route native OpenAI and Anthropic API-key model requests through Caveman. Otherwise provider calls remain direct. |
| `JIAN_CAVEMAN_PROXY_URL` | no | `http://127.0.0.1:8788` | Exact proxy origin. The default starts the bundled listener when Caveman is enabled in the image; override it for a separately managed proxy. |
| `JIAN_PUBLIC_URL` | no | — | Where the outside world reaches this installation, over HTTPS: the web server's address, which passes the callbacks on. Telegram webhooks and OAuth callbacks use it. Required for the GitHub integration. |
| `JIAN_TRUSTED_PROXIES` | behind the web server | empty | Who may state the client's address, scheme and host in `X-Forwarded-*`: comma-separated addresses, CIDR ranges, or `loopback`, `linklocal` and `uniquelocal`. Compose sets `uniquelocal`. Empty, the socket peer is the client. |
| `JIAN_WORKSPACES` | no | `$HOME/workspaces` | Where each profile's workspace is created, one directory per profile. |
| `POSTGRES_PASSWORD` | Compose only | — | The PostgreSQL password in `compose.yaml`; it also builds the service's `DATABASE_URL`. |
| `JIAN_VERSION` | Compose only | `latest` | The tag of both images `compose.yaml` uses. |
| `JIAN_BIND_ADDRESS` | Compose only | `127.0.0.1` | The host address the web server is published on. |
| `JIAN_BIND_PORT` | Compose only | `4310` | The host port the web server is published on. |

The web server's:

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `JIAN_GATEWAY_URL` | no | `http://gateway:4310` in the image | Where the gateway listens, seen from the web container. Read on every request. |
| `PORT` | no | `3000` | The listening port; the health check follows it. |
| `HOSTNAME` | no | `0.0.0.0` in the image | The listening address inside the container. |

The web server keeps no secret and no state: the host token, the keyring and the database belong to the gateway alone.

### GitHub App

To enable **Integrations → GitHub**, set `JIAN_PUBLIC_URL` to the externally reachable HTTPS URL
of this installation (the web server's). In the panel, choose **Create GitHub App** and confirm Jian's manifest on GitHub.
GitHub returns the generated credentials directly to Jian, which stores them encrypted in the
gateway vault. Jian requests repository write access for the official GitHub MCP toolsets,
including Actions, Issues, Pull Requests, repository contents and security findings. Installation
tokens are minted per run and restricted to the repository selected by that profile's Project;
tokens are not stored. Each installed GitHub account is shared by all Jian agents, while Projects
remain profile-specific. GitHub requires existing App owners to update the App's permissions and
approve the change for each installation; Integrations → Apps → GitHub shows any missing App
permissions and links to the relevant GitHub settings.

The published image includes Caveman's local proxy but leaves it stopped by default. To start
its private, record-only listener alongside Jian, set this variable in Compose or the container:

```bash
JIAN_CAVEMAN_ENABLED=true make up
```

For source development without the image, start a separate listener instead:

```bash
CAVEMAN_MODE=record caveman start --port 8788
JIAN_CAVEMAN_ENABLED=true make dev
```

The image starts and supervises the bundled listener only when enabled with that exact loopback
URL. For any other configured origin, provide a separately managed proxy reachable from the gateway
container. Jian does not retry a failed model request directly, because a retry could duplicate
work. Keep external listeners private; `127.0.0.1` inside a container is not the host.
Only native OpenAI and Anthropic API-key requests use this route. Codex/Claude subscriptions,
custom endpoints, OpenRouter and Google continue directly. Set `JIAN_CAVEMAN_ENABLED=false` to
turn routing off. The bundled listener is forced to `record`, which preserves request bytes; Jian cannot
change the mode of a separately managed listener.

Provider, MCP and channel keys do not live in the environment: they are typed in the panel and stored encrypted with the keyring. See [security](security.md).

## Moving the panel out of the gateway

Until this change the gateway served the panel itself, at `/ui/`. The panel is now the `jian-web` image, and a gateway updated on its own answers `/ui/` with a page that explains the move instead of the panel. The API, channels, webhooks and remote workers keep working throughout; only the panel is missing until the web server is added. Nothing in the database changes.

**Installed from a template (Cubeship or another platform).** Reinstall the Jian template or update it to its latest version, so it adds the web service. Keep the same database and the same `JIAN_API_TOKEN`, `JIAN_ACTIVE_KEY_ID` and `JIAN_MASTER_KEYS`. Then move the installation's domain from the gateway service to the web service, and set `JIAN_TRUSTED_PROXIES` on the gateway to the platform's private network (`uniquelocal` on most). Because the web server passes `/v1`, `/health`, `/openapi.json` and `/jian-remote.mjs` on, the webhook, OAuth callback and remote worker addresses already registered on that domain keep working, and `JIAN_PUBLIC_URL` does not change. The gateway service no longer needs a public domain.

**Compose from a clone.** Run `git pull`, `make pull` and `make up`. The web server takes the host port the gateway published, so the panel opens on the same address, now at its root.

**Your own containers or Kubernetes.** Add the web server as in [way 2](#way-2--the-images-on-their-own) or [way 3](#way-3--kubernetes), at the gateway's version, point `JIAN_GATEWAY_URL` at the gateway, move the public port or the Ingress to it, and set `JIAN_TRUSTED_PROXIES` on the gateway.

Panel addresses change: each screen now lives under the agent it belongs to, `/agents/:profileId/...`, and old `/ui/...` bookmarks no longer lead anywhere — open the panel at its root. An app installed from the old panel should be removed and installed again from the new address.

## Published tags

| Tag | When it is written |
| --- | --- |
| `1.2.3` | The tag `v1.2.3`. The only immutable one. |
| `1.2` | The tag `v1.2.3`; moves to the latest fix in that series. |
| `latest` | The tag `v1.2.3`; moves to the most recent published version. |

## Updating and rolling back

Updating means changing the tag of both images and starting again. The migration runs at startup.

```bash
# Compose: pin the version in .env and recreate the containers
echo 'JIAN_VERSION=1.3.0' >> .env && make up

# Standalone containers
docker pull ghcr.io/lucasaarch/jian-gateway:1.3.0 && docker pull ghcr.io/lucasaarch/jian-web:1.3.0
docker rm -f jian && docker run -d --name jian ... ghcr.io/lucasaarch/jian-gateway:1.3.0
docker rm -f jian-web && docker run -d --name jian-web ... ghcr.io/lucasaarch/jian-web:1.3.0

# Kubernetes
kubectl set image deployment/jian gateway=ghcr.io/lucasaarch/jian-gateway:1.3.0
kubectl set image deployment/jian-web web=ghcr.io/lucasaarch/jian-web:1.3.0
```

Take a dump before updating: a migration changes the schema and does not undo itself.

```bash
docker compose exec postgres pg_dump -U jian -Fc jian > jian-$(date +%F).dump
```

Rolling back means pointing at the previous version — `make up` with another `JIAN_VERSION`, or `kubectl rollout undo deployment/jian`. That reverts the code, **not** the schema: a migration already applied stays in the database. If the older version refuses the newer schema, restore the dump:

```bash
docker compose exec -T postgres pg_restore -U jian -d jian --clean --if-exists < jian-2026-09-22.dump
```

Published migrations are immutable; a fix arrives as the next version, never as a change to the previous one.

## Where the data lives

Everything the gateway keeps is in PostgreSQL: profiles, sessions, history, memories, runs, the pg-boss queue and the credential vault. The one exception is each agent's workspace under `/home/node/workspaces` — the tools it installed, SSH keys, Git and `gh` logins — which Compose keeps in the named volume `jian_gateway_home`. Recreating the container loses nothing.

Under Compose the database lives in the named volume `jian_postgres_data`; the development one lives in `jian-dev_postgres_data`. `make down` keeps the volume, `docker compose down -v` deletes it. `make db-reset` deletes the development one on purpose.

The `JIAN_MASTER_KEYS` keyring lives outside the database, in `.env` or in a secret manager. Without it a database backup is useless: the vault will not open. Keep it apart, and keep the older entries until every secret has been re-entered under the new key.

## Publishing

The `Publish` workflow builds each image, `jian-gateway` and `jian-web`, on two native runners, `ubuntu-24.04` and `ubuntu-24.04-arm`, each pushing by digest, and a final job per image joins them into a multi-architecture index. Nothing is emulated. Both images always carry the same tags. A package GHCR has never seen starts private: after the first release that publishes `jian-web`, make it public in the package settings, or installations cannot pull it. On the same tag it also stages the npm package `@jian-ai/remote-control` at that version for a maintainer to promote. It runs on a `v*.*.*` tag and nowhere else (aside from `workflow_dispatch`, which builds an image only).

A release is a note and a tag, both by hand:

1. Write `docs/releases/1.2.3.md`: a front matter with `date: YYYY-MM-DD`, an optional `summary:`, and the note. It becomes the GitHub release and the dialog the panel opens once after the update. The version is chosen by whoever writes the note, not computed from commits.
2. Commit the note and push `main`, then run `make release VERSION=1.2.3`. The version lives only in the tag; workspace `package.json` files stay at their placeholder versions. The Publish workflow stamps `@jian-ai/remote-control` to `1.2.3` for that stage only.
3. The tag runs the `Publish` workflow: it checks the note, builds both images for both architectures, stages `@jian-ai/remote-control@1.2.3` on npm (`npm stage publish`), and publishes the GitHub release with the note. A maintainer then promotes the staged package on npmjs.com (2FA) before installers see the new version.

### npm auth (`NPM_TOKEN`)

The npm job needs a repository secret named `NPM_TOKEN`: an npm **Automation** (or
**stage-only**) token with write access on the `@jian-ai` scope (and the package
`@jian-ai/remote-control` once it exists). CI cannot publish versions directly anymore; it
runs `npm stage publish`, and a maintainer promotes the staged version in the npm dashboard
(or with `npm stage approve`, which requires 2FA). Without the secret the npm job fails with
a short message; the gateway image and GitHub release still publish. Add the secret, then
re-run the npm job or cut the next release tag.

`make release` refuses a version with no note, a working tree with changes, a `main` that is not on `origin`, and a tag that already exists; a published version is never moved. A candidate such as `1.2.3-rc.1` publishes its own image tag and a pre-release, and leaves `latest` alone.

The notes are copied into the image, and the image carries its version in `JIAN_VERSION`. After an update the panel shows the notes of every version newer than the one the owner last read, once; closing the dialog records the version in the database, so another browser does not show it again. A first visit shows only the running release. A build with no version, such as `make dev`, announces nothing.
