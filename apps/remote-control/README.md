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

Requires Node.js 24+. Full documentation: [docs/remote.md](../../docs/remote.md).
