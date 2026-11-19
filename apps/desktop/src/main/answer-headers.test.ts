import { describe, expect, it } from 'vitest';
import { answerHeaders } from './answer-headers';

describe('a gateway answer passed to the window', () => {
  it('drops what crashes a sandboxed Artifact frame and the gateway cookie, and keeps the rest', () => {
    const answered = answerHeaders(
      new Headers({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; frame-ancestors 'self'",
        'origin-agent-cluster': '?1',
        'set-cookie': 'jian_session=synthetic',
        'cache-control': 'public, max-age=3600',
      }),
    );

    expect(answered.get('origin-agent-cluster')).toBeNull();
    expect(answered.get('set-cookie')).toBeNull();
    expect(answered.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    );
    expect(answered.get('cache-control')).toBe('public, max-age=3600');
  });
});
