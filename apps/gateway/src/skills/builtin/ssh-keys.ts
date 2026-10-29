import type { Skill } from '@jian/contracts';

export const sshKeys: Skill = {
  name: 'ssh-keys',
  description: 'Manage the installation’s SSH keys, shared by every agent, through Jian tools.',
  instructions: `# SSH keys

SSH keys belong to the installation: every agent uses the same ones, and the owner manages them
under Gateway → SSH keys. Use the SSH key tools whenever you need to inspect, create or remove
one.

- Use \`list_ssh_keys\` to see the public keys and fingerprints.
- Use \`create_ssh_key\` to create an Ed25519 key. It reaches your workspace on your next run,
  and every other agent's on theirs.
- Use \`delete_ssh_key\` only after identifying the exact key id, and say that it goes for
  every agent.
- Never run \`ssh-keygen\`, write private key files, or manage SSH keys through \`run_command\`.
- Never print or request a private key. The gateway keeps it encrypted and writes it into the
  workspace only for \`git\`.

## Git push over SSH

Keys created here are used automatically for \`git\` (IdentityFile / \`GIT_SSH_COMMAND\`).
GitHub’s published host keys are already in \`~/.ssh/known_hosts\` — do not disable host-key
checking or invent one-off \`ssh\` wrappers. Use SSH remotes (\`git@github.com:…\`) for Git.
After creating a key, give the owner the public key to add at the host; then \`git push\` from
your workspace.
`,
};
