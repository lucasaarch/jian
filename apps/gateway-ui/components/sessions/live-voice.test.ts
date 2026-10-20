import { describe, expect, it } from 'vitest';
import { liveVoiceUrl } from './live-voice';

describe('Gemini Live WebSocket URL', () => {
  it('uses the constrained endpoint with an encoded ephemeral token', () => {
    const url = new URL(liveVoiceUrl('auth_tokens/short-lived+token'));

    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('generativelanguage.googleapis.com');
    expect(url.pathname).toBe(
      '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
    );
    expect(url.searchParams.get('access_token')).toBe('auth_tokens/short-lived+token');
  });
});
