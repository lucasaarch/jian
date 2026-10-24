import type {
  Capability,
  EffectiveProfession,
  ProfessionAuthority,
  Profile,
} from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import { findProfession } from './catalog.js';
import { requireCapability, resolveProfessionAuthority } from './policy.js';

/** Shared effect-layer check. Legacy compatibility is explicit, not null authority = allow. */
export function requireProfileCapability(profile: Profile, capability: Capability): void {
  const authority = profileAuthority(profile);
  if (authority !== undefined) requireCapability(authority, capability);
}

/** Owner configuration may enable an optional grant, never exceed the profession ceiling. */
export function requireProfessionCeiling(profile: Profile, capability: Capability): void {
  if (profile.professionId === null) return;
  const definition = findProfession(profile.professionId);
  requireCapability(
    definition
      ? {
          professionId: definition.id,
          policyVersion: definition.policyVersion,
          capabilities: definition.capabilities,
        }
      : null,
    capability,
  );
}

/** Configuration enables an optional capability; identity/instructions never do. */
export function enabledCapabilities(profile: Profile): Capability[] {
  const definition = findProfession(profile.professionId);
  if (!definition) return [];
  return [
    ...definition.defaultCapabilities,
    ...(profile.allowWebSearch ? ['web.browse' as const] : []),
    // Creating an unclassified child would escape the creator's ceiling. Keep classified
    // profile creation unavailable until the server can persist bounded child authority.
    ...(profile.allowSelfManagement ? ['identity.manage' as const] : []),
    ...(profile.reachableByAgents ? ['peers.call' as const] : []),
    ...(profile.mcpServers.some((server) => server.transport === 'http')
      ? ['mcp.http' as const]
      : []),
    ...(profile.mcpServers.some((server) => server.transport === 'stdio')
      ? ['mcp.stdio' as const]
      : []),
    // Machine ACLs and media model settings remain independent checks in their services.
    'remote.control',
    'media.image',
  ];
}

/** null is a legacy *profile*, never an authorization fallback for an unknown profession. */
export function profileAuthority(
  profile: Profile,
  inherited?: ProfessionAuthority,
): ProfessionAuthority | undefined {
  if (profile.professionId === null) {
    if (inherited)
      throw new GatewayError(403, 'Classified work cannot run as an unclassified profile');
    return undefined;
  }
  const definition = findProfession(profile.professionId);
  const authority = resolveProfessionAuthority(profile.professionId, {
    enabled: enabledCapabilities(profile),
    context: definition?.capabilities ?? [],
    ...(inherited ? { inherited } : {}),
  });
  if (!authority) throw new GatewayError(403, 'Profession authority is unavailable');
  return authority;
}

/** Presentation only: reuse live configuration policy, without claiming run/resource authority. */
export function effectiveProfession(profile: Profile): EffectiveProfession {
  const authority = profileAuthority(profile);
  if (!authority) {
    return {
      status: 'legacy_unclassified',
      assignable: false,
      scope: 'configuration',
      profession: null,
      ceilingCapabilities: null,
      configurationEffectiveCapabilities: null,
    };
  }
  const definition = findProfession(authority.professionId);
  if (!definition) throw new GatewayError(403, 'Profession authority is unavailable');
  return {
    status: 'classified',
    assignable: false,
    scope: 'configuration',
    profession: {
      id: definition.id,
      label: definition.label,
      policyVersion: definition.policyVersion,
    },
    ceilingCapabilities: [...definition.capabilities],
    configurationEffectiveCapabilities: authority.capabilities,
  };
}

/** Run snapshots preserve content, not privileges. Both the original and live limits apply. */
export function currentRunAuthority(
  frozen: Profile,
  current: Profile,
  original?: ProfessionAuthority,
): ProfessionAuthority | undefined {
  if (frozen.professionId === null && current.professionId === null && !original) return undefined;
  if (
    !original ||
    frozen.professionId !== current.professionId ||
    original.professionId !== frozen.professionId
  ) {
    throw new GatewayError(403, 'Run authority requires owner review');
  }
  const snapshot = profileAuthority(frozen, original);
  if (!snapshot) throw new GatewayError(403, 'Run authority requires owner review');
  return profileAuthority(current, snapshot);
}
