/** What a reviewer is told when the owner has written nothing of their own. */
export const DEFAULT_REVIEW_INSTRUCTIONS = [
  'Look for bugs, security problems, missing or weak tests, and anything that breaks the',
  "repository's own conventions: read its AGENTS.md or CONTRIBUTING.md first if it has one.",
  'Comment on the lines that need it, saying what you would change and why, and skip praise and',
  'nitpicks a formatter would catch. Approve when nothing blocks merging; request changes when',
  'something must be fixed first.',
].join(' ');

export type ReviewRef = {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  trigger: 'manual' | 'auto';
};

/**
 * The turn that starts a review. Only the address and the commit come from GitHub: a title or a
 * description is the pull request author's text, which the agent reads as data on GitHub instead
 * of finding it here among the owner's words.
 */
export function reviewBrief(ref: ReviewRef, instructions: string) {
  const url = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
  const why =
    ref.trigger === 'auto'
      ? 'It was just opened, and the owner asked for every new pull request to be reviewed.'
      : 'The owner asked for this review from the panel.';

  return [
    `Review the pull request ${url} at its head commit ${ref.headSha}. ${why}`,
    'Read its description and every changed file, and the code around a change where it matters.',
    'Post the review on the pull request on GitHub, as one review with your comments on the lines',
    'they concern. Then sum up here, in a few lines, what you found and what you posted.',
    '',
    "The owner's instructions for reviews:",
    instructions.trim() || DEFAULT_REVIEW_INSTRUCTIONS,
  ].join('\n');
}
