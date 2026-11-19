/**
 * A React Artifact handed to another AI as a prompt: the component as written, and what to make
 * of it, for React as it is or rewritten for another framework. The panel copies it from the
 * component's menu and a public link from its toolbar, so both say exactly the same.
 *
 * Kept pure and small, since the public page assembles it in a browser from these same parts:
 * the gateway writes each target's parts into the page and the page puts the source between
 * them, so a source of hundreds of kilobytes is written into the page once, not once a target.
 */

/**
 * Each framework a prompt can ask for, in the order a menu lists them. `ask` is the one
 * instruction that differs, `prop` what a tweak becomes there, and `only` what the result may
 * depend on.
 */
export const COMPONENT_PROMPT_TARGETS = [
  {
    id: 'react',
    label: 'React',
    ask: 'Add it to my React project as it is. Change only what the project needs around it, such as its imports, the file it lives in and how it is exported.',
    prop: 'prop',
    only: 'React',
  },
  {
    id: 'vue',
    label: 'Vue 3',
    ask: 'Rewrite it as a Vue 3 single-file component (`.vue`) with the Composition API and `<script setup lang="ts">`.',
    prop: 'prop declared with `defineProps`',
    only: 'Vue',
  },
  {
    id: 'angular',
    label: 'Angular',
    ask: 'Rewrite it as an Angular standalone component (Angular 17 or later) that keeps its state in signals, with its template and styles in the component.',
    prop: 'signal input (`input()`)',
    only: 'Angular',
  },
  {
    id: 'svelte',
    label: 'Svelte 5',
    ask: 'Rewrite it as a Svelte 5 component (`.svelte`) with runes (`$state`, `$derived`, `$effect`, `$props`) and `<script lang="ts">`.',
    prop: 'prop',
    only: 'Svelte',
  },
  {
    id: 'solid',
    label: 'SolidJS',
    ask: 'Rewrite it as a SolidJS component in TSX, with signals, stores and effects in place of React hooks.',
    prop: 'prop',
    only: 'SolidJS',
  },
  {
    id: 'html',
    label: 'HTML, CSS and JavaScript',
    ask: 'Rewrite it as one HTML file with plain CSS and JavaScript: no framework and no build step, its script doing what the component does.',
    prop: 'constant at the top of the script',
    only: 'the browser',
  },
  {
    id: 'react-native',
    label: 'React Native',
    ask: 'Rewrite it as a React Native component in TypeScript, with core components (`View`, `Text`, `Pressable`, `ScrollView`) and `StyleSheet` in place of DOM elements and CSS, as close to the original as the platform allows.',
    prop: 'prop',
    only: 'React Native',
  },
] as const;

export type ComponentPromptTarget = (typeof COMPONENT_PROMPT_TARGETS)[number]['id'];

/**
 * A code fence longer than any run of backticks in the source, so nothing in it closes the block
 * early, however the component writes its template strings or comments.
 */
function fence(source: string): string {
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((run) => run[0].length));

  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * What goes before and after the source in the prompt for `target`: the whole prompt is
 * `before + source + after`. Only the fence depends on the source.
 */
export function componentPromptParts(
  target: ComponentPromptTarget,
  title: string,
  source: string,
): [before: string, after: string] {
  const chosen =
    COMPONENT_PROMPT_TARGETS.find((each) => each.id === target) ?? COMPONENT_PROMPT_TARGETS[0];
  const marks = fence(source);
  const before = [
    `# ${title.trim() || 'Component'}`,
    '',
    `Here is a React component written in TypeScript (TSX). ${chosen.ask}`,
    '',
    'Keep it the same component:',
    '',
    '- Behaviour: every state, interaction, animation and edge case works as it does now.',
    `- Look: the same layout, colours, spacing, typography and responsive behaviour. Carry its styles over as they are written (inline styles, a style element, class names), in the way ${chosen.only === 'the browser' ? 'plain CSS' : chosen.only} applies them.`,
    `- Props: if it exports \`tweaks\`, each entry is a prop with its default value. Keep each one as a ${chosen.prop} with the same name and default.`,
    `- Dependencies: it imports nothing but React. Use nothing but ${chosen.only}: no UI kit, icon set or styling library.`,
    '',
    'Answer with the complete code, ready to paste into a file, then a short note on anything that could not be carried over exactly.',
    '',
    `${marks}tsx`,
    '',
  ].join('\n');

  return [before, source.endsWith('\n') ? `${marks}\n` : `\n${marks}\n`];
}

/** The whole prompt for `target`, as it is copied. */
export function componentPrompt(
  target: ComponentPromptTarget,
  component: { title: string; source: string },
): string {
  const [before, after] = componentPromptParts(target, component.title, component.source);

  return before + component.source + after;
}
