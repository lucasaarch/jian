import { capabilitySchema, type ProfessionAuthority } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import {
  findProfession,
  professionCatalog,
  validateProfessionCatalog,
} from '../src/professions/catalog.js';
import {
  CapabilityDenied,
  requireCapability,
  resolveProfessionAuthority,
} from '../src/professions/policy.js';

const all = capabilitySchema.options;
const unrestricted = { enabled: all, context: all };

function authority(id: string): ProfessionAuthority {
  const result = resolveProfessionAuthority(id, unrestricted);
  if (!result) throw new Error('Expected authority');
  return result;
}

describe('profession policy foundation (not activated in the runtime)', () => {
  it('has stable validated definitions with fixed capability sets', () => {
    expect(() => validateProfessionCatalog(professionCatalog)).not.toThrow();
    expect(professionCatalog.map((item) => item.id)).toEqual(['developer', 'attendant']);
    expect(new Set(professionCatalog.flatMap((item) => item.capabilities))).toEqual(
      new Set(all.filter((capability) => capability !== 'profiles.create')),
    );
  });

  it('rejects duplicate definitions and capabilities', () => {
    const definition = professionCatalog[0];
    if (!definition) throw new Error('Missing definition');
    expect(() => validateProfessionCatalog([definition, definition])).toThrow(
      'Duplicate profession',
    );
    expect(() =>
      validateProfessionCatalog([
        { ...definition, capabilities: [...definition.capabilities, 'process.exec'] },
      ]),
    ).toThrow('Duplicate capabilities');
  });

  it.each([null, undefined, '', 'designer', '__proto__', 'DEVELOPER'])(
    'fails closed for unclassified/unknown profession %s',
    (id) => {
      expect(findProfession(id)).toBeUndefined();
      expect(resolveProfessionAuthority(id, unrestricted)).toBeNull();
      expect(() => requireCapability(null, 'process.exec')).toThrow(CapabilityDenied);
    },
  );

  it('intersects owner and context grants without implicit defaults', () => {
    const result = resolveProfessionAuthority('developer', {
      enabled: ['process.exec', 'workspace.files'],
      context: ['workspace.files', 'web.browse'],
    });
    expect(result?.capabilities).toEqual(['workspace.files']);
    expect(
      resolveProfessionAuthority('developer', { enabled: [], context: all })?.capabilities,
    ).toEqual([]);
  });

  it('never grants workstation or delegation tools to attendants, even when requested in every set', () => {
    const attendant = authority('attendant');
    for (const capability of [
      'process.exec',
      'workspace.files',
      'web.browse',
      'remote.control',
      'ssh.manage',
      'tasks.delegate',
      'profiles.create',
      'mcp.stdio',
      'coordination.lease',
    ] as const) {
      expect(() => requireCapability(attendant, capability)).toThrow(CapabilityDenied);
    }
    expect(() => requireCapability(attendant, 'conversation.send')).not.toThrow();
    expect(() => requireCapability(attendant, 'peers.call')).not.toThrow();
    expect(() => requireCapability(authority('developer'), 'process.exec')).not.toThrow();
  });

  it('keeps campaigns exclusive to Sales Attendant and narrows older Developer executions safely', () => {
    const developer = authority('developer');
    const attendant = authority('attendant');
    expect(developer.policyVersion).toBe(2);
    expect(developer.capabilities).not.toContain('campaigns.read');
    expect(developer.capabilities).not.toContain('campaigns.manage');
    expect(attendant.capabilities).toContain('campaigns.read');
    expect(attendant.capabilities).toContain('campaigns.manage');

    const previousExecution: ProfessionAuthority = {
      ...developer,
      policyVersion: 1,
      capabilities: [...developer.capabilities, 'campaigns.read', 'campaigns.manage'],
    };
    const currentExecution = resolveProfessionAuthority('developer', {
      ...unrestricted,
      inherited: previousExecution,
    });
    expect(currentExecution?.policyVersion).toBe(2);
    expect(currentExecution?.capabilities).toContain('process.exec');
    expect(currentExecution?.capabilities).not.toContain('campaigns.read');
    expect(currentExecution?.capabilities).not.toContain('campaigns.manage');
  });

  it('keeps the origin ceiling across cross-profession delegation and subsequent resumptions', () => {
    const origin = authority('attendant');
    const delegated = resolveProfessionAuthority('developer', {
      ...unrestricted,
      inherited: origin,
    });
    expect(delegated?.capabilities).not.toContain('process.exec');
    if (!delegated) throw new Error('Missing authority');
    const resumed = resolveProfessionAuthority('developer', {
      ...unrestricted,
      inherited: delegated,
    });
    expect(resumed).toEqual(delegated);
    expect(() => requireCapability(resumed, 'process.exec')).toThrow(CapabilityDenied);
  });

  it('does not revive revoked permissions or expand an old run after an owner grant', () => {
    const original = resolveProfessionAuthority('developer', {
      enabled: ['workspace.files'],
      context: all,
    });
    if (!original) throw new Error('Missing authority');
    expect(
      resolveProfessionAuthority('developer', { ...unrestricted, inherited: original })
        ?.capabilities,
    ).toEqual(['workspace.files']);
    expect(
      resolveProfessionAuthority('developer', { enabled: [], context: all, inherited: original })
        ?.capabilities,
    ).toEqual([]);
  });

  it('rejects forged or future inherited policy instead of trusting snapshot data', () => {
    const origin = authority('attendant');
    expect(
      resolveProfessionAuthority('developer', {
        ...unrestricted,
        inherited: { ...origin, capabilities: ['process.exec'] },
      }),
    ).toBeNull();
    expect(
      resolveProfessionAuthority('developer', {
        ...unrestricted,
        inherited: { ...origin, policyVersion: 999 },
      }),
    ).toBeNull();
    expect(
      resolveProfessionAuthority('developer', {
        ...unrestricted,
        inherited: { ...origin, policyVersion: 0 },
      }),
    ).toBeNull();
    expect(() =>
      requireCapability({ ...origin, capabilities: ['process.exec'] }, 'process.exec'),
    ).toThrow(CapabilityDenied);
  });

  it('reports a stable denial code and never turns approval into a capability', () => {
    try {
      requireCapability(authority('attendant'), 'process.exec');
      throw new Error('Expected denial');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityDenied);
      expect(error).toMatchObject({
        code: 'capability_denied',
        statusCode: 403,
        capability: 'process.exec',
      });
    }
  });
});
