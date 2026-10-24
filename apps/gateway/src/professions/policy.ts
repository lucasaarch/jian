import {
  type Capability,
  type ProfessionAuthority,
  professionAuthoritySchema,
} from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import { findProfession } from './catalog.js';

/** All sets must be derived by the server, not from tool inputs or a caller's brief. */
export type AuthorityConstraints = {
  /** Currently enabled by the owner, including optional grants. No implicit enabling here. */
  enabled: readonly Capability[];
  /** Source/session restrictions. Resource ACLs still belong to their responsible service. */
  context: readonly Capability[];
  /** Persisted original authority on a resumed/delegated job. Missing legacy jobs must not use this path. */
  inherited?: ProfessionAuthority;
};

/** Shared pure policy used by runtime and service-layer authorization. */
export function resolveProfessionAuthority(
  professionId: unknown,
  constraints: AuthorityConstraints,
): ProfessionAuthority | null {
  const profession = findProfession(professionId);
  if (!profession) return null;

  let inherited: ProfessionAuthority | undefined;
  if (constraints.inherited !== undefined) {
    const parsed = professionAuthoritySchema.safeParse(constraints.inherited);
    if (!parsed.success) return null;
    inherited = parsed.data;
    // Delegation across professions intersects capabilities, not mutable identity text.
    // The inherited version belongs to its own profession and must be understood locally.
    const origin = findProfession(inherited.professionId);
    if (!origin || inherited.policyVersion > origin.policyVersion) return null;
    if (inherited.capabilities.some((capability) => !origin.capabilities.includes(capability)))
      return null;
  }

  const enabled = new Set(constraints.enabled);
  const context = new Set(constraints.context);
  const ceiling = inherited && new Set(inherited.capabilities);
  return {
    professionId: profession.id,
    policyVersion: profession.policyVersion,
    capabilities: profession.capabilities.filter(
      (capability) =>
        enabled.has(capability) && context.has(capability) && (!ceiling || ceiling.has(capability)),
    ),
  };
}

/** A stable error code separate from localized/user-facing descriptions. */
export class CapabilityDenied extends GatewayError {
  readonly code = 'capability_denied';

  constructor(readonly capability: Capability) {
    super(403, `Capability denied: ${capability}`);
  }
}

export function requireCapability(
  authority: ProfessionAuthority | null,
  capability: Capability,
): void {
  // Treat stored/foreign authority as data too: never trust a fabricated capability list.
  const parsed = professionAuthoritySchema.safeParse(authority);
  const profession = parsed.success && findProfession(parsed.data.professionId);
  if (
    !parsed.success ||
    !profession ||
    parsed.data.policyVersion !== profession.policyVersion ||
    !profession.capabilities.includes(capability) ||
    !parsed.data.capabilities.includes(capability)
  ) {
    throw new CapabilityDenied(capability);
  }
}
