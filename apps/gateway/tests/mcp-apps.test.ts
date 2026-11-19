import { mcpAppOf } from '@jian/contracts';
import { describe, expect, it } from 'vitest';

// The gateway names an account and counts an app's use by the app its address belongs to; one
// it does not recognise would be counted as a custom server and lose its card in the panel.
describe('the app a saved server is', () => {
  it('is HeyGen however the trailing slash was typed', () => {
    expect(mcpAppOf('https://mcp.heygen.com/mcp/v1/')).toBe('heygen');
    expect(mcpAppOf('https://mcp.heygen.com/mcp/v1')).toBe('heygen');
  });

  it('is ElevenLabs at the EU residency address too', () => {
    expect(mcpAppOf('https://api.elevenlabs.io/v1/mcp')).toBe('elevenlabs');
    expect(mcpAppOf('https://api.eu.residency.elevenlabs.io/v1/mcp')).toBe('elevenlabs');
  });

  it('is Higgsfield at its server, and no app at a look-alike', () => {
    expect(mcpAppOf('https://mcp.higgsfield.ai/mcp')).toBe('higgsfield');
    expect(mcpAppOf('https://mcp.higgsfield.ai.example.com/mcp')).toBeUndefined();
    expect(mcpAppOf('https://api.elevenlabs.io/v1/mcp/other')).toBeUndefined();
  });
});
