import { describe, expect, it } from 'vitest';
import { mcpClientDisconnected } from '../src/agent/mcp-errors.js';

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
