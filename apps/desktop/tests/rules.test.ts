import { describe, expect, it } from 'vitest';
import { compatible, parseGatewayUrl } from '../src/main/gateways/rules';

describe('a gateway address', () => {
  it('keeps the origin and path, without a trailing slash', () => {
    expect(parseGatewayUrl(' https://jian.example.com/ ')).toEqual({
      url: 'https://jian.example.com',
    });
    expect(parseGatewayUrl('http://192.168.1.20:4310/jian/')).toEqual({
      url: 'http://192.168.1.20:4310/jian',
    });
  });

  it('refuses what is not a plain web address', () => {
    expect(parseGatewayUrl('jian.example.com')).toHaveProperty('error');
    expect(parseGatewayUrl('ftp://jian.example.com')).toHaveProperty('error');
    expect(parseGatewayUrl('https://owner:secret@jian.example.com')).toHaveProperty('error');
    expect(parseGatewayUrl('https://jian.example.com/?token=x')).toHaveProperty('error');
  });
});

describe('a gateway release the app can work with', () => {
  it('shares the app major.minor', () => {
    expect(compatible('1.2.0', '1.2.7')).toBe(true);
    expect(compatible('1.2.0', '1.3.0')).toBe(false);
    expect(compatible('2.0.0', '1.9.9')).toBe(false);
  });

  it('is never refused when either side is a development build', () => {
    expect(compatible('0.0.0-dev', '1.3.0')).toBe(true);
    expect(compatible('1.2.0', undefined)).toBe(true);
  });
});
