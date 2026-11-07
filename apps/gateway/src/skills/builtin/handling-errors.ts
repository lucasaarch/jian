import type { Skill } from '@jian/contracts';

export const handlingErrors: Skill = {
  name: 'handling-errors',
  description:
    'Use when a tool, an attachment, a provider or a channel returns an error, when something you tried did not work, or when someone asks why something failed.',
  instructions: `# When something fails

An error is information. Read it, say what it means in plain words, and say what fixes it.
Never answer only "something went wrong", never invent a cause, and never claim to have
checked logs you cannot read. Use the error details you were given; a tool failure may include
structured origin, code, path or validation fields as well as a message.

## Reading an error

The useful part is usually at the end: \`Media provider answered HTTP 400 — file must be one
of flac, mp3, ogg\` says who refused (the media provider), how (400) and why (the file type).
Quote that last part to the person, word for word, when it is what they need to act.

By the HTTP status:

- **400** — the request was refused as wrong: an unsupported file, a model that does not do
  this, a parameter it does not take. The message after the status says which.
- **401 / 403** — the key or token was refused: missing, wrong, revoked, or without access to
  that model. Fixed under **Providers**.
- **404** — the model does not exist for that account, or the address is wrong. Fixed under
  **Capabilities** (another model) or **Providers** (the address of a server).
- **413** — the file is too large. Files go up to 16 MB.
- **429** — rate limit or quota: too many requests, or the free allowance is spent. It passes
  with time, or with a paid plan, or with another model or provider for that activity.
- **500, 502, 503, 504** — the provider is failing or overloaded. The gateway already tried
  again; trying later usually works. Another model for that activity avoids the wait.

The conversation's own model is different: a call to it that cannot connect (a timeout, a
refused or reset connection, DNS, TLS) or is answered 408, 409, 425, 429, 5xx or 529, before
any of its answer arrived, does not fail the turn. The gateway tries it again ten times a second apart, then after 30 seconds, 1,
2 and 4 minutes, then every 5 minutes, for as long as it takes, and never sooner than the
provider's \`retry-after\`. The panel says **Reconnecting to the model** meanwhile, with the
attempts and when the next one goes. The turn goes on where it was once a call gets through;
the owner's Cancel stops it. Any other status, such as 400 for a request too large or 401,
fails at once.

Other messages you may see:

- "Provider key is not configured" — no provider is set for that activity: **Providers**,
  then **Capabilities**.
- "blocked" or "private address" on a server the owner runs — its origin must be allowed in
  \`JIAN_ALLOW_PRIVATE_ORIGINS\`.
- "Stopped: nothing came back … for 5 minutes" — a model or tool hung; the completed steps
  are saved.
- A tool that is not there at all — its group is not loaded (\`load_tools\`), or this run does not
  have it: a subagent has no browser or X tools, and a conversation outside the desktop app has no
  browser.
- A channel that does not deliver — check Channels in the panel; WhatsApp may need its QR
  code scanned again.
- An MCP server that does not connect or needs sign-in — the owner can test or sign in under
  Settings → MCP servers.
- An X call refused — see \`x\`: no credits, or an account to connect again.
- Web search refused — check the Tavily key under Providers.

## What to say

1. What failed, in one sentence, naming the thing: "The voice note could not be transcribed."
2. Why, from the error: "Groq refused the file type."
3. What fixes it, and where: "Choose Gemini for Incoming audio under Capabilities, or send
   it as text."

In a chat, keep it that short. With the owner in the panel, give the exact error text too,
so they can search for it or pass it on.

## What to do yourself

- Try another way when there is one: a failed attachment can be asked for again, a failed
  search can be phrased differently. Do not retry the same call hoping for another answer.
- Never repeat an action with an outside effect after it failed or timed out without first
  checking whether it happened (see \`long-running-work\`).
- When an error keeps coming back, keep what caused it and what fixed it as a memory, so the
  next turn does not rediscover it.`,
};
