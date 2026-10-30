import { describe, expect, it } from 'vitest';
import { linkIn, linkTarget } from '../src/main/link-target';

describe('a jian:// link from outside the app', () => {
  it('opens the local gateway’s panel at the place and outcome it names', () => {
    expect(linkTarget('jian://open/settings/integrations?github=registered')).toEqual({
      gatewayId: 'local',
      path: '/settings/integrations?github=registered',
    });
    expect(linkTarget('jian://open')).toEqual({ gatewayId: 'local', path: '/' });
  });

  it('is ignored when it is not one the app makes', () => {
    expect(linkTarget('jian://app/index.html')).toBeUndefined();
    expect(linkTarget('https://open/settings')).toBeUndefined();
    expect(linkTarget('not a link')).toBeUndefined();
  });

  it('is found among the arguments a second launch was given', () => {
    expect(linkIn(['/Applications/Jian', '--flag', 'jian://open/settings'])).toBe(
      'jian://open/settings',
    );
    expect(linkIn(['/Applications/Jian'])).toBeUndefined();
  });
});
