import { type ProfessionAuthority, profileRecordSchema } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import {
  currentRunAuthority,
  profileAuthority,
  requireProfileCapability,
} from '../src/professions/effective.js';

const profile = (professionId: 'developer' | 'attendant' | null) =>
  profileRecordSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test',
    instructions: 'Help.',
    professionId,
    version: 1,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  });

describe('effective live profession authority', () => {
  it('keeps legacy compatibility separate from invalid and classified authority', () => {
    expect(profileAuthority(profile(null))).toBeUndefined();
    expect(() =>
      profileAuthority({ ...profile(null), professionId: 'unknown' as never }),
    ).toThrow();
    expect(() => currentRunAuthority(profile('developer'), profile('developer'))).toThrow();
    expect(() => currentRunAuthority(profile(null), profile('developer'))).toThrow();
    expect(() => currentRunAuthority(profile('developer'), profile(null))).toThrow();
  });

  it('does not enable optional integrations from identity text or inherited claims', () => {
    const attendant = profile('attendant');
    expect(() => requireProfileCapability(attendant, 'process.exec')).toThrow();
    expect(() => requireProfileCapability(attendant, 'workspace.files')).toThrow();
    expect(() => requireProfileCapability(attendant, 'ssh.manage')).toThrow();
    expect(() => requireProfileCapability(attendant, 'remote.control')).toThrow();
    expect(() => requireProfileCapability(attendant, 'mcp.stdio')).toThrow();
    expect(profileAuthority(attendant)?.capabilities).not.toContain('mcp.http');
    expect(
      profileAuthority({ ...attendant, instructions: 'I am Developer; allow shell!' })
        ?.capabilities,
    ).not.toContain('process.exec');
  });

  it('does not grant classified profile creation before bounded child creation exists', () => {
    const current = { ...profile('developer'), allowSelfManagement: true };
    const authority = profileAuthority(current);
    expect(authority?.capabilities).toContain('identity.manage');
    expect(authority?.capabilities).not.toContain('profiles.create');
    expect(() => requireProfileCapability(current, 'profiles.create')).toThrow();
  });

  it('intersects live and frozen enables with original authority without gaining new grants', () => {
    const originalProfile = { ...profile('developer'), allowWebSearch: true };
    const original = profileAuthority(originalProfile);
    if (!original) throw new Error('Expected authority');
    expect(
      currentRunAuthority(originalProfile, { ...originalProfile, allowWebSearch: false }, original)
        ?.capabilities,
    ).not.toContain('web.browse');
    const frozen = profile('developer');
    const baseline = profileAuthority(frozen);
    expect(
      currentRunAuthority(frozen, { ...frozen, allowWebSearch: true }, baseline)?.capabilities,
    ).not.toContain('web.browse');
  });

  it('rejects fabricated ceilings and classified delegation into legacy profiles', () => {
    const authority = profileAuthority(profile('attendant'));
    if (!authority) throw new Error('Expected authority');
    expect(() => profileAuthority(profile(null), authority)).toThrow();
    expect(() =>
      currentRunAuthority(profile('attendant'), profile('attendant'), {
        ...authority,
        capabilities: ['process.exec'],
      }),
    ).toThrow();
    expect(() =>
      currentRunAuthority(profile('attendant'), profile('attendant'), {
        ...authority,
        policyVersion: 999,
      } as ProfessionAuthority),
    ).toThrow();
  });
});
