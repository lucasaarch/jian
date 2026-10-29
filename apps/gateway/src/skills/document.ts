import { GatewayError } from '../core/errors.js';

/** The SKILL.md body becomes the agent's instructions, and the contract caps them here. */
const MAX_INSTRUCTIONS = 12_000;

export type SkillDocument = {
  name: string;
  description: string;
  instructions: string;
};

function unquote(value: string): string {
  const trimmed = value.trim();

  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Reads the open SKILL.md format: a YAML block between `---` fences, then markdown.
 * Only `name` and `description` are read, so the nested keys other runtimes add — allowed
 * tools, MCP dependencies — are skipped rather than misparsed. Not a YAML implementation.
 */
export function parseSkillDocument(text: string, fallbackName?: string): SkillDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));

  if (!match) {
    throw new GatewayError(422, 'SKILL.md has no frontmatter block');
  }

  const fields = new Map<string, string>();

  for (const line of (match[1] as string).split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);

    if (field && (field[2] as string).trim()) {
      fields.set((field[1] as string).toLowerCase(), unquote(field[2] as string));
    }
  }

  const name = (fields.get('name') ?? fallbackName ?? '').toLowerCase();
  const description = fields.get('description') ?? '';
  const instructions = (match[2] as string).trim();

  if (!/^[a-z0-9_-]{1,64}$/.test(name)) {
    throw new GatewayError(422, 'SKILL.md needs a name of letters, digits, hyphens or underscores');
  }

  if (!description) {
    throw new GatewayError(422, `Skill ${name} has no description`);
  }

  if (!instructions) {
    throw new GatewayError(422, `Skill ${name} has no instructions`);
  }

  return {
    name,
    description: description.slice(0, 300),
    instructions: instructions.slice(0, MAX_INSTRUCTIONS),
  };
}
