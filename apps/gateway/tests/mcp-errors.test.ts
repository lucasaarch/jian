import { describe, expect, it } from 'vitest';
import { mcpClientDisconnected, mcpOutcomeUncertain } from '../src/agent/mcp-errors.js';

describe('mcpClientDisconnected', () => {
  it('recognizes a closed client before send', () => {
    expect(
      mcpClientDisconnected(new Error('Attempted to send a request from a closed client')),
    ).toBe(true);
  });

  it('recognizes other pre-send transport deaths', () => {
    expect(mcpClientDisconnected(new Error('MCP SSE Transport Error: Not connected'))).toBe(true);
    expect(mcpClientDisconnected(new Error('The MCP command is not running'))).toBe(true);
  });

  it('walks causes so reconnect failures stay never-sent', () => {
    expect(
      mcpClientDisconnected(
        new Error('MCP server github closed before the call, and reconnect failed: unreachable', {
          cause: new Error('Attempted to send a request from a closed client'),
        }),
      ),
    ).toBe(true);
  });

  it('does not treat a mid-flight disconnect as never-sent', () => {
    expect(mcpClientDisconnected(new Error('Connection closed'))).toBe(false);
    expect(mcpClientDisconnected(new Error('fetch failed'))).toBe(false);
  });
});

describe('mcpOutcomeUncertain', () => {
  it('treats mid-flight transport collapse as uncertain', () => {
    expect(mcpOutcomeUncertain(new Error('Connection closed'))).toBe(true);
    expect(mcpOutcomeUncertain(new Error('fetch failed'))).toBe(true);
    expect(mcpOutcomeUncertain(new Error('Request timed out after 20000ms'))).toBe(true);
  });

  it('does not treat clear API / validation refusals as uncertain', () => {
    expect(
      mcpOutcomeUncertain(
        new Error('Validation Failed: Invalid value for "milestone": 0 — status 422'),
      ),
    ).toBe(false);
    expect(
      mcpOutcomeUncertain(
        new Error('GitHub API error: milestone value -1 invalid — HTTP 422 Validation Failed'),
      ),
    ).toBe(false);
    expect(mcpOutcomeUncertain(new Error('header mismatch: missing Mcp-Param-owner header'))).toBe(
      false,
    );
  });

  it('does not treat pre-send disconnect as uncertain (reconnect path)', () => {
    expect(mcpOutcomeUncertain(new Error('Attempted to send a request from a closed client'))).toBe(
      false,
    );
  });
});
