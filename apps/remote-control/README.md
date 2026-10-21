# `@jian-ai/remote-control`

Jian Remote Control worker. Connects a Windows, macOS, or Linux computer to a Jian gateway
over outbound HTTPS polling.

## Install

```sh
npm install -g @jian-ai/remote-control
jian-remote install --gateway https://gateway.example --machine MACHINE_UUID --token WORKER_TOKEN
```

Or without a global install:

```sh
npx @jian-ai/remote-control@latest install \
  --gateway https://gateway.example \
  --machine MACHINE_UUID \
  --token WORKER_TOKEN
```

## Update

```sh
npx @jian-ai/remote-control@latest update
# or: jian-remote update [--version 0.6.0]
```

Reads `~/.config/jian-remote` (no token, machine id, or gateway flags), installs a compatible
build, and restarts the worker service.

## Configure

Change the stored gateway URL and/or worker token without a full reinstall (restarts the
existing OS service):

```sh
jian-remote configure --token WORKER_TOKEN
jian-remote configure --gateway https://gateway.example --token WORKER_TOKEN
```

## Compatibility

Worker and gateway must share the same major.minor. See [docs/remote.md](../../docs/remote.md).

Requires Node.js 24+.
