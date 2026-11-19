import { COMPONENT_PROMPT_TARGETS, componentPrompt, componentPromptParts } from '@jian/contracts';
import { describe, expect, it } from 'vitest';

describe('a prompt for a component', () => {
  const source = `export const tweaks = { label: { type: 'text', default: 'Count' } };
export default function Counter({ label = 'Count' }) {
  return <p>{\`\${label}\`}</p>;
}
`;

  it('carries the whole source, whole, for every framework', () => {
    for (const target of COMPONENT_PROMPT_TARGETS) {
      const prompt = componentPrompt(target.id, { title: 'Counter', source });

      expect(prompt.startsWith('# Counter\n'), target.id).toBe(true);
      expect(prompt, target.id).toContain(target.ask);
      expect(prompt, target.id).toContain(`\`\`\`tsx\n${source}\`\`\`\n`);
      // The page that puts it together on a click gets the same prompt as the panel.
      const [before, after] = componentPromptParts(target.id, 'Counter', source);
      expect(before + source + after).toBe(prompt);
    }
  });

  it('keeps a fence in the source from closing its block early', () => {
    const fenced = 'export default () => <pre>{"```\\n"}</pre>;\n// ````\n';
    const prompt = componentPrompt('vue', { title: 'Fenced', source: fenced });

    // A fence longer than any run of backticks in it, which only closes after it.
    expect(prompt).toContain(`\`\`\`\`\`tsx\n${fenced}\`\`\`\`\`\n`);
    expect(prompt.endsWith('`````\n')).toBe(true);
  });

  it('asks for the props a component declares as tweaks to stay, with their defaults', () => {
    expect(componentPrompt('angular', { title: ' ', source })).toMatch(
      /^# Component\n[\s\S]*`tweaks`[\s\S]*signal input \(`input\(\)`\) with the same name and default/,
    );
  });
});
