import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { McpServerReader } from '../mcp/port.js';
import type { SkillLibrary } from './library.js';
import type { Skills } from './service.js';

type SkillRouteServices = {
  /** Absent in a gateway built without an outbound client; import is then refused. */
  skills?: Skills;
  skillLibrary: SkillLibrary;
  mcp: McpServerReader;
};

type SkillParams = { name: string };

function importer(deps: SkillRouteServices): Skills {
  if (!deps.skills) {
    throw new GatewayError(503, 'Skill import is not configured');
  }

  return deps.skills;
}

/** The installation's skills, for the owner: every agent is offered what these routes leave on. */
export function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteServices): void {
  const library = deps.skillLibrary;

  app.get('/v1/skills', async () => library.list());

  app.post('/v1/skills', async (request, reply) =>
    reply.code(201).send(await library.create(request.body)),
  );

  app.post('/v1/skills/import', async (request) => importer(deps).importSkill(request.body));

  app.patch<{ Params: SkillParams }>('/v1/skills/:name', async (request) =>
    library.update(request.params.name, request.body),
  );

  app.delete<{ Params: SkillParams }>('/v1/skills/:name', async (request, reply) => {
    await library.remove(request.params.name);
    return reply.code(204).send();
  });

  app.put<{ Params: SkillParams }>('/v1/skills/:name/enabled', async (request) =>
    library.setEnabled(request.params.name, request.body),
  );

  // An imported skill and its source: whether the two differ, and copying the source again.
  app.get<{ Params: SkillParams }>('/v1/skills/:name/upstream', async (request) =>
    importer(deps).upstream(request.params.name),
  );

  app.post<{ Params: SkillParams }>('/v1/skills/:name/update', async (request) =>
    importer(deps).updateFromSource(request.params.name),
  );

  // The instructions travel with the list: the owner cannot edit a built-in, so reading it is
  // the only way to know what their agents were told. Listed against the installation's
  // servers: what a run lends itself, such as GitHub's, is not shown here.
  app.get('/v1/built-in-skills', async () => library.builtin(await deps.mcp.list()));
}
