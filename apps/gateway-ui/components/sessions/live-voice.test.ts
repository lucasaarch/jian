import { describe, expect, it, vi } from 'vitest';
import { liveVoiceToolResponses, liveVoiceUrl } from './live-voice';

describe('Gemini Live tool calls', () => {
  it('returns correlated function responses and refuses malformed or excess calls', async () => {
    const execute = vi.fn(async (name: string) => ({ tool: name }));
    const calls = [
      { id: '1', name: 'read_recent_conversation', args: {} },
      { id: '2', name: 'delegate_to_jian', args: { task: 'Check status' } },
      { id: '3', name: 'unsupported', args: {} },
      { id: '4', name: 'unsupported', args: {} },
      { id: '5', name: 'delegate_to_jian', args: { task: 'extra' } },
    ];
    const responses = await liveVoiceToolResponses(calls, execute);

    expect(responses[0]).toEqual({
      id: '1',
      name: 'read_recent_conversation',
      response: { result: { tool: 'read_recent_conversation' } },
    });
    expect(responses[1]).toEqual({
      id: '2',
      name: 'delegate_to_jian',
      response: { result: { tool: 'delegate_to_jian' } },
    });
    expect(responses[4]?.response).toEqual({ error: 'Tool call was rejected or failed.' });
    expect(execute).toHaveBeenCalledTimes(4);

    const duplicateTasks = await liveVoiceToolResponses(
      [
        { id: 'a', name: 'delegate_to_jian', args: { task: 'one' } },
        { id: 'b', name: 'delegate_to_jian', args: { task: 'two' } },
      ],
      execute,
    );
    expect(duplicateTasks[1]?.response).toEqual({ error: 'Tool call was rejected or failed.' });
  });
});

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
