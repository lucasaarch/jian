---
name: desktop-and-web
description: Use for any change to the panel, its commands, or a gateway route. A change on the desktop app or the web panel must be carried over to the other, with what each host alone has.
---

# Desktop and web

Both hosts draw the same panel from `packages/ui`. Treat them as one product: work that lands on one
and not the other is unfinished.

## The rule

When you change one host, in the same work:

1. Put the UI, state and logic in `packages/ui`, so the other host gets it.
2. Open the other host's code path and adapt what differs: its entry, its commands, its routes.
3. If it cannot apply there, say so in your report, and make sure nothing there breaks or promises
   it. Hide the entry; never leave a control that does nothing.

## Where things go

| | Shared | Desktop | Web |
|---|---|---|---|
| Entry | `app/chats.tsx`, `ChatsApp` | `apps/desktop/src/renderer/gateways/gateway-panel.tsx` | `packages/ui/src/app/web-app.tsx`, `apps/web` |
| Commands | `useAgentCommands`, `useAppCommands`, `ChatCommands` | `renderer/commands/window-commands.ts`, `chrome/browser-panel.tsx` | `useCommands('web', …)` in `web-app.tsx` |
| Chrome | | title bar and status bar in `renderer/chrome` | the bar passed as `header` |
| Settings | `AppSettings` | opens by state | opens by address, `/settings/<page>` |
| Reaching the gateway | | `main/protocol.ts`, which signs each request | `/v1` passed through `apps/web` |

A detail only one host has reaches the panel as a prop or slot, like `AppHost`, `header` or
`welcomes`. Do not check which host you are on inside a screen.

## What only one has

- **Desktop:** native browser, local gateway, tray, updates, this computer as a machine, system
  notifications. Offered only if the host passes them, as `openBrowser` does.
- **Web:** signing in and out, addresses that open a screen, phone layouts. Test `phone:` styles
  and overlays that fill the screen.
- **Mode, not host:** channels and machines exist only on a server gateway. Ask `useGatewayMode()`.
  The desktop app can be connected to either.

## Agent tools follow the same split

- `browser_control` exists only for a conversation the owner is having in the desktop app, which
  signs its requests with `x-jian-client`. The web panel, channels and subagents never get it.
- When a feature differs by context, change every place that tells the agent about it: the tool's
  description, its replies, and the skill. `webResearchFor` shows the pattern.

## Before you finish

- Does the other host have a way in, or a reason it does not?
- New address: does the web route exist, and does the desktop navigate there?
- New gateway route outside `/v1`: both hosts forward it?
- New external resource: both content security policies, `apps/web/proxy.ts` and
  `apps/desktop/src/renderer/index.html`, allow it?
- New shortcut: a browser may reserve it (`reserved` in `app/commands/keybindings.ts`).
- Both themes, and a phone width on web.
- Say which host you actually ran. Unit tests run neither.
