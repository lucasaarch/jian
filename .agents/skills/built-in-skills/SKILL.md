---
name: built-in-skills
description: Use when adding or changing an agent tool, a panel screen or its name, a setting, a limit or how Jian behaves, or when asked to review what the agent knows about Jian. The built-in skills in the gateway must keep saying what is true.
---

# Built-in skills

`apps/gateway/src/skills/builtin` is what every agent believes about Jian and how to work in it. The
agent acts on it, and tells the owner what it says. A stale skill sends the owner to a screen that is
gone, or the agent after a tool it does not have.

## When a change touches one

Search the folder for the name you changed. Then update it in the same work:

| You changed | Look at |
|---|---|
| A new agent tool or tool group | The skill for that job, or a new one. A test fails until it is taught. |
| A screen, a label, where a setting lives | `jian-configuration`, `handling-errors`, and whatever names it |
| A limit, a timeout, a size | Every skill that states the number |
| What the product is, ships or offers | `about-jian`, and https://usejian.app if it says the same |
| What the image installs | `machine-tools` |
| What a run may do, by host or by subagent | The skill's run-specific version, as below |

## What keeps them honest

`apps/gateway/tests/skills-truth.test.ts` fails when a skill names a tool that does not exist, when a
tool is taught nowhere, when a skill points at a skill that does not exist, or when it names a screen
the panel lost. Add a retired name to `GONE` when you retire one. It cannot read meaning: a wrong
number or path passes it, so read what you are changing against the code.

## Writing one

- **The description decides whether it is ever opened.** Say when to use it, in the words the
  situation arrives in. It costs every turn, as all descriptions are in the catalog, so keep it to
  one sentence and to 300 characters.
- **The body costs only when loaded,** up to 12,000 characters. Exact tool names, what to do when a
  step fails, and why a rule exists. No history of how it used to be.
- **Never point at a tool the run does not have.** When the answer depends on the run, build the
  skill for it at `load_skill`, as `webResearchFor` and `xFor` do, or offer it only with what it
  teaches, as `builtinSkills` does for MCP.
- **One job each.** A new skill spends catalog room on every turn of every agent: extend one that
  fits before adding one, and delete one that stopped earning its place.
- English, fictional names. A real person's or computer's name never goes in an example.

## Run-time check

Skills run in the gateway, so restart it to see a change (**Restart local gateway** in the palette).
