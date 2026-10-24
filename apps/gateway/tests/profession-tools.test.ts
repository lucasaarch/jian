import { readdirSync, readFileSync } from 'node:fs';
import { capabilitySchema, type ProfessionAuthority } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deferTools, offeredGroups } from '../src/agent/tools.js';
import { CapabilityDenied, resolveProfessionAuthority } from '../src/professions/policy.js';
import {
  filterToolSet,
  guardToolSet,
  requireToolCapabilities,
  ToolCapabilityDenied,
  toolCapabilities,
} from '../src/professions/tools.js';

function authority(profession = 'developer'): ProfessionAuthority {
  const result = resolveProfessionAuthority(profession, {
    enabled: capabilitySchema.options,
    context: capabilitySchema.options,
  });
  if (!result) throw new Error('Expected authority');
  return result;
}

function fakeTools(names: string[], execute = vi.fn(async () => 'effect')): ToolSet {
  return Object.fromEntries(
    names.map((name) => [name, tool({ inputSchema: z.object({}), execute })]),
  );
}

const options = { toolCallId: 'test', messages: [], context: undefined };

function call(tools: ToolSet, name: string, input: unknown = {}) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`Missing executor: ${name}`);
  return execute(input as never, options);
}

describe('native profession tool authorization', () => {
  it('classifies all 73 actual native tool registrations (not just a second name list)', () => {
    const root = new URL('../src/', import.meta.url);
    const names = new Set<string>();
    for (const path of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!path.endsWith('.ts')) continue;
      const source = readFileSync(new URL(path, root), 'utf8');
      // Current native registrations are object properties or tools.name assignments.
      // Also count all tool calls so a new unsupported registration form cannot disappear.
      const registrations = [...source.matchAll(/\b(\w+)\s*(?::|=)\s*tool\s*\(/g)];
      expect(registrations.length, path).toBe([...source.matchAll(/\btool\s*\(\s*\{/g)].length);
      for (const match of registrations) {
        if (match[1]) names.add(match[1]);
      }
    }
    expect(names.size).toBe(73);
    expect(Object.keys(toolCapabilities).sort()).toEqual([...names].sort());
    for (const capabilities of Object.values(toolCapabilities)) {
      for (const capability of capabilities) expect(capabilitySchema.options).toContain(capability);
    }
  });

  it('filters before deferred groups and leaves the original tool set intact', () => {
    const tools = fakeTools(['run_command', 'read_file', 'list_sessions', 'unknown_native']);
    const filtered = filterToolSet(tools, authority('attendant'));
    expect(Object.keys(filtered)).toEqual(['list_sessions']);
    expect(Object.keys(tools)).toHaveLength(4);
    expect(offeredGroups(filtered)).toEqual(['conversations']);
    deferTools(filtered, new Set());
    expect(filtered.load_tools).toBeDefined();
    expect(filtered.run_command).toBeUndefined();
  });

  it('fails closed on null, forged, stale authority, unknown names and prototype properties', () => {
    const developer = authority();
    for (const invalid of [null, { ...developer, policyVersion: 999 }]) {
      expect(filterToolSet(fakeTools(['load_tools', 'run_command']), invalid)).toEqual({});
      expect(() => requireToolCapabilities(invalid, 'load_tools')).toThrow(ToolCapabilityDenied);
    }
    const forged = { ...authority('attendant'), capabilities: ['process.exec'] as const };
    expect(() =>
      requireToolCapabilities({ ...forged, capabilities: [...forged.capabilities] }, 'run_command'),
    ).toThrow(CapabilityDenied);
    for (const name of ['new_native', '__proto__', 'constructor', 'toString']) {
      expect(() => requireToolCapabilities(developer, name)).toThrow(ToolCapabilityDenied);
    }
  });

  it.each(['mcp.http', 'mcp.stdio'] as const)(
    'MCP discovery and loading accept %s alone',
    (capability) => {
      const current = { ...authority(), capabilities: [capability] };
      for (const name of ['search_mcp_tools', 'load_mcp_tools']) {
        expect(() => requireToolCapabilities(current, name)).not.toThrow();
        expect(() => requireToolCapabilities({ ...current, capabilities: [] }, name)).toThrow(
          ToolCapabilityDenied,
        );
      }
      expect(() =>
        requireToolCapabilities(
          { ...authority('attendant'), capabilities: ['mcp.http'] },
          'load_mcp_tools',
        ),
      ).not.toThrow();
    },
  );

  it('requires all conjunctive capabilities, not just one', () => {
    for (const name of ['send_file', 'save_attachment', 'generate_image', 'send_sticker']) {
      const required = toolCapabilities[name];
      if (!required) throw new Error('Missing tool');
      for (const missing of required) {
        expect(() =>
          requireToolCapabilities(
            {
              ...authority(),
              capabilities: authority().capabilities.filter((item) => item !== missing),
            },
            name,
          ),
        ).toThrow(CapabilityDenied);
      }
    }
  });

  it('guards the effective send_file source without disallowing media IDs or content', () => {
    const current = authority('attendant');
    expect(() =>
      requireToolCapabilities(current, 'send_file', { source: 'path', path: '/a' }),
    ).toThrow(CapabilityDenied);
    expect(() => requireToolCapabilities(current, 'send_file', { path: '/a' })).toThrow(
      CapabilityDenied,
    );
    for (const source of ['mediaId', 'content']) {
      expect(() =>
        requireToolCapabilities(current, 'send_file', {
          source,
          path: '/ignored',
          [source]: 'value',
        }),
      ).not.toThrow();
    }
    expect(() => requireToolCapabilities(authority(), 'send_file', { path: '/a' })).not.toThrow();
  });

  it('accepts trusted dynamic classification but cannot override native capabilities', () => {
    const mapping = { mcp__example: ['mcp.http'] as const, run_command: [] };
    expect(filterToolSet(fakeTools(['mcp__example']), authority('attendant'))).toEqual({});
    expect(
      Object.keys(filterToolSet(fakeTools(['mcp__example']), authority('attendant'), mapping)),
    ).toEqual(['mcp__example']);
    expect(() =>
      requireToolCapabilities(authority('attendant'), 'run_command', {}, mapping),
    ).toThrow(CapabilityDenied);
  });

  it('rechecks async authority on every invocation, before any executor or approval effect', async () => {
    let current: ProfessionAuthority | null = authority();
    const approvedExecutor = vi.fn(async () => 'approved effect');
    const getAuthority = vi.fn(async () => current);
    const original = fakeTools(['run_command'], approvedExecutor);
    const guarded = guardToolSet(filterToolSet(original, current), getAuthority);
    expect(guarded.run_command?.inputSchema).toBe(original.run_command?.inputSchema);
    expect(await call(guarded, 'run_command')).toBe('approved effect');
    current = { ...current, capabilities: [] };
    await expect(call(guarded, 'run_command')).rejects.toBeInstanceOf(CapabilityDenied);
    current = null;
    await expect(call(guarded, 'run_command')).rejects.toBeInstanceOf(ToolCapabilityDenied);
    expect(getAuthority).toHaveBeenCalledTimes(3);
    expect(approvedExecutor).toHaveBeenCalledTimes(1);
  });

  it('guards tools added by loaders and propagates authority callback failure without effects', async () => {
    const execute = vi.fn(async () => 'effect');
    const getAuthority = vi.fn(async () => {
      throw new Error('authority unavailable');
    });
    const guarded = guardToolSet(fakeTools(['load_tools'], execute), getAuthority);
    await expect(call(guarded, 'load_tools')).rejects.toThrow('authority unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
});
