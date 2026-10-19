import type { Skill } from '@jian/contracts';

export const sshKeys: Skill = {
  name: 'ssh-keys',
  description: 'Manage this profile’s SSH keys through Jian tools.',
  instructions: `# SSH keys

Use the SSH key tools whenever you need to inspect, create or remove a key for this profile.

- Use \`list_ssh_keys\` to see the public keys and fingerprints.
- Use \`create_ssh_key\` to create an Ed25519 key.
- Use \`delete_ssh_key\` only after identifying the exact key id.
- Never run \`ssh-keygen\`, write private key files, or manage SSH keys through \`run_command\`.
- Never print or request a private key. The gateway keeps it in this profile’s workspace.

## Git push over SSH

Keys created here are used automatically for \`git\` (IdentityFile / \`GIT_SSH_COMMAND\`).
GitHub’s published host keys are already in \`~/.ssh/known_hosts\` — do not disable host-key
checking or invent one-off \`ssh\` wrappers. Prefer SSH remotes (\`git@github.com:…\`) over
\`gh\` when the owner has not logged \`gh\` in. After creating a key, give the owner the public
key to add at the host; then \`git push\` from this workspace.
`,
};
