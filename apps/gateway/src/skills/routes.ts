import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { ProfileParams } from '../http/params.js';
import type { McpServerReader } from '../mcp/port.js';
import type { ProfileReader } from '../profiles/port.js';
import { builtinSkills } from './builtin/index.js';
import type { Skills } from './service.js';

type SkillRouteServices = { skills?: Skills; profiles: ProfileReader; mcp: McpServerReader };

function available(deps: SkillRouteServices): Skills {
  if (!deps.skills) {
    throw new GatewayError(503, 'Skill import is not configured');
  }

  return deps.skills;
}

export function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteServices): void {
  // The instructions travel with the list: the owner cannot edit a built-in, so reading it is
  // the only way to know what their agent was told.
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/built-in-skills', async (request) => {
    const profile = await deps.profiles.profile(request.params.profileId);
    const disabled = new Set(profile.disabledSkills);

    // The installation's servers: what a run lends itself, such as GitHub's, is not listed here.
    return builtinSkills(await deps.mcp.list()).map((skill) => ({
      ...skill,
      enabled: !disabled.has(skill.name),
    }));
  });

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/skill-catalog', async (request) =>
    available(deps).catalog(request.query),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/skills/import', async (request) =>
    available(deps).importSkill(request.params.profileId, request.body),
  );
}
