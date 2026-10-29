import { expect, it } from 'vitest';
import { agentPath, currentSection } from './navigation';

const agent = '11111111-1111-4111-8111-111111111111';
it('marks the section of an agent route, including its child routes', () => {
  expect(currentSection(agentPath(agent))?.label).toBe('Overview');
  expect(currentSection(agentPath(agent, 'sessions/abc'))?.label).toBe('Chats');
  expect(currentSection(agentPath(agent, 'integrations/github'))?.label).toBe('Integrations');
  expect(currentSection('/sign-in')).toBeUndefined();
});
