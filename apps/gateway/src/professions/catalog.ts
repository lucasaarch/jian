import {
  type Capability,
  type ProfessionDefinition,
  professionDefinitionSchema,
  professionIdSchema,
} from '@jian/contracts';

const common: Capability[] = [
  'conversation.control',
  'conversation.read',
  'conversation.send',
  'memory.use',
  'skills.read',
  'skills.write',
  'activity.read',
  'decisions.query',
  'schedules.manage',
  'media.use',
];

const developerDefaults: Capability[] = [
  ...common,
  'subscriptions.github',
  'coordination.lease',
  'workspace.files',
  'process.exec',
  'ssh.manage',
  'tasks.delegate',
];

/** Definitions only: no profession is assignable until end-to-end enforcement ships. */
export const professionCatalog: readonly ProfessionDefinition[] = [
  {
    id: 'developer',
    label: 'Developer',
    description: 'Software development with workspace tools and explicitly enabled integrations.',
    policyVersion: 1,
    capabilities: [
      ...developerDefaults,
      'web.browse',
      'remote.control',
      'mcp.http',
      'mcp.stdio',
      'peers.call',
      'identity.manage',
      'profiles.create',
      'media.image',
    ],
    defaultCapabilities: developerDefaults,
  },
  {
    id: 'attendant',
    label: 'Attendant',
    description: 'Customer service within authorized conversations and business integrations.',
    policyVersion: 1,
    capabilities: [...common, 'mcp.http', 'media.image'],
    defaultCapabilities: common,
  },
];

/** Validate once at composition time; unknown/new entries never fall back to developer. */
export function validateProfessionCatalog(definitions: readonly ProfessionDefinition[]): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    professionDefinitionSchema.parse(definition);
    if (ids.has(definition.id)) throw new Error(`Duplicate profession: ${definition.id}`);
    ids.add(definition.id);
    for (const values of [definition.capabilities, definition.defaultCapabilities]) {
      if (new Set(values).size !== values.length)
        throw new Error(`Duplicate capabilities: ${definition.id}`);
    }
    if (
      definition.defaultCapabilities.some(
        (capability) => !definition.capabilities.includes(capability),
      )
    )
      throw new Error(`Defaults exceed profession ceiling: ${definition.id}`);
  }
}

validateProfessionCatalog(professionCatalog);

export function findProfession(id: unknown): ProfessionDefinition | undefined {
  const parsed = professionIdSchema.safeParse(id);
  return parsed.success
    ? professionCatalog.find((definition) => definition.id === parsed.data)
    : undefined;
}
