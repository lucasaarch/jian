#!/bin/sh
# OpenSSH resolves ~ through passwd, not HOME. Keep its user files in the workspace.
config="$HOME/.ssh/config"
if [ ! -f "$config" ]; then
  config=/dev/null
fi

# Always prefer the workspace known_hosts (seeded with GitHub's published keys by the gateway).
set -- -o "UserKnownHostsFile=\"$HOME/.ssh/known_hosts\"" -o IdentitiesOnly=yes "$@"

# Conventional identities plus Jian-managed keys under ~/.ssh/jian/<id>/.
for key in \
  "$HOME/.ssh/id_rsa" \
  "$HOME/.ssh/id_ecdsa" \
  "$HOME/.ssh/id_ecdsa_sk" \
  "$HOME/.ssh/id_ed25519" \
  "$HOME/.ssh/id_ed25519_sk" \
  "$HOME/.ssh/jian/"*/id_ed25519
do
  if [ -f "$key" ]; then
    set -- -o "IdentityFile=\"$key\"" "$@"
  fi
done

# When no identity file exists yet, still advertise the conventional paths so ssh -G output
# matches a normal OpenSSH client in an empty workspace (tests and first-run git).
if [ ! -f "$HOME/.ssh/id_rsa" ] \
  && [ ! -f "$HOME/.ssh/id_ecdsa" ] \
  && [ ! -f "$HOME/.ssh/id_ecdsa_sk" ] \
  && [ ! -f "$HOME/.ssh/id_ed25519" ] \
  && [ ! -f "$HOME/.ssh/id_ed25519_sk" ] \
  && ! ls "$HOME/.ssh/jian/"*/id_ed25519 >/dev/null 2>&1
then
  set -- \
    -o "IdentityFile=\"$HOME/.ssh/id_rsa\"" \
    -o "IdentityFile=\"$HOME/.ssh/id_ecdsa\"" \
    -o "IdentityFile=\"$HOME/.ssh/id_ecdsa_sk\"" \
    -o "IdentityFile=\"$HOME/.ssh/id_ed25519\"" \
    -o "IdentityFile=\"$HOME/.ssh/id_ed25519_sk\"" \
    "$@"
fi

exec /usr/bin/ssh -F "$config" "$@"
