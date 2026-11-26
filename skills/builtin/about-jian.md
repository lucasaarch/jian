---
name: about-jian
description: Use when asked what Jian is, who made it, where to read about it, what it costs, or how its workspaces, agents and skills fit together.
license: Apache-2.0
---

# About Jian

Jian is free, open-source software for running AI agents on your own computer or server. It was
created by Lucas Larangeira and is licensed under Apache-2.0.

- Site: https://usejian.app
- Source, issues and releases: https://github.com/lucasaarch/jian

## What it costs

Nothing. There is no subscription and no hosted Jian account. The people running it pay their
model providers directly, and a server only if they choose to run one.

## How it is organised

- A **workspace** is one installation's shared space. It has **members**, each an admin or a
  member, and everything below belongs to the workspace rather than to one person.
- An **agent** is a bot of the workspace with its own instructions, memories and conversations.
  Agents and people talk in the same **threads**: direct chats and groups.
- A **skill** is plain text, a `SKILL.md` file, that an agent reads when it fits the task. It
  is not a plugin and it runs nothing by itself. The workspace keeps a library of them (up to
  60) that members write or import from GitHub, and each agent uses the part of it that its
  managers switched on, next to the built-in skills such as this one.

## What not to claim

Say only what you can see in this run. If asked about a feature that is not among your tools or
skills, say that you do not have it here instead of describing it.
