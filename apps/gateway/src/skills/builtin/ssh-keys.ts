import type { Skill } from '@jian/contracts';

const body = (written: string, gitSection: string) => `# SSH keys

SSH keys belong to the installation: every agent uses the same ones, and the owner manages them
under Settings → SSH keys. Use the SSH key tools whenever you need to inspect, create or remove
one.

- Use \`list_ssh_keys\` to see the public keys and fingerprints.
- Use \`create_ssh_key\` to create an Ed25519 key. Every agent can use it from its next run.
- Use \`delete_ssh_key\` only after identifying the exact key id, and say that it goes for
  every agent.
- Never run \`ssh-keygen\`, write private key files, or manage SSH keys through \`run_command\`.
- Never print or request a private key. The gateway keeps it encrypted and writes it ${written}
  only for \`git\`.

## Git push over SSH

${gitSection} When the owner connected GitHub under Settings → Apps, \`github_git\` needs no key
for GitHub repositories (\`github\` skill).
`;

/** What is true where the run is: a desktop never puts a key in the owner's `~/.ssh`. */
export const sshKeys: Skill = {
  name: 'ssh-keys',
  description:
    'Use when SSH keys come up: listing, creating or removing one, or when Git over SSH needs a key.',
  instructions: body(
    'into the directory the agents share',
    `Keys created here are used automatically for \`git\` (IdentityFile / \`GIT_SSH_COMMAND\`).
GitHub’s published host keys are already in \`~/.ssh/known_hosts\` — do not disable host-key
checking or invent one-off \`ssh\` wrappers. Use SSH remotes (\`git@github.com:…\`) for Git.
After creating a key, give the owner the public key to add at the host; then \`git push\` from
the checkout.`,
  ),
};

const onOwnerComputer: Skill = {
  ...sshKeys,
  instructions: body(
    "into Jian's own data",
    `Keys created here live in Jian's own data, with their own known hosts, and never in the owner's
\`~/.ssh\`. \`git\` offers them through \`GIT_SSH_COMMAND\` alongside the owner's own keys and
configuration, which keep working. GitHub’s published host keys come with them — do not disable
host-key checking or invent one-off \`ssh\` wrappers. Plain \`ssh\` uses only the owner's setup.
Use SSH remotes (\`git@github.com:…\`) for Git. After creating a key, give the owner the public
key to add at the host; then \`git push\` from the checkout.`,
  ),
};

export const sshKeysFor = (owner: boolean): Skill => (owner ? onOwnerComputer : sshKeys);
