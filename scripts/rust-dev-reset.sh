#!/bin/sh
# Deletes the data directory of `make rust-dev`, after stopping the Postgres that runs from it.
# Usage: rust-dev-reset.sh <absolute path of .jian-dev>
#
# Only that directory is touched, and only a process whose command line names its own pgdata is
# stopped: a recycled pid or another cluster is never signalled.
set -eu

dir=${1:?usage: rust-dev-reset.sh <.jian-dev directory>}
case "$dir" in
  */.jian-dev) ;;
  *) echo "refusing to delete $dir: not a .jian-dev directory" >&2; exit 1 ;;
esac
[ -d "$dir" ] || { echo "nothing to reset: $dir does not exist"; exit 0; }

pgdata="$dir/pgdata"
pid_file="$pgdata/postmaster.pid"
if [ -f "$pid_file" ]; then
  pid=$(head -n 1 "$pid_file")
  # A zombie shows as `[postgres] <defunct>` with no path: it is dead, not ours to stop.
  if ps -o args= -p "$pid" 2>/dev/null | grep -F -- "$pgdata" | grep -q postgres; then
    pg_ctl=$(ls "$dir"/postgres/*/bin/pg_ctl 2>/dev/null | head -n 1 || true)
    [ -n "$pg_ctl" ] || { echo "Postgres $pid is running but its pg_ctl is missing; stop it by hand" >&2; exit 1; }
    echo "stopping the Postgres of $pgdata (pid $pid)"
    "$pg_ctl" stop -m fast -w -D "$pgdata" || { echo "could not stop it; $dir is kept" >&2; exit 1; }
  fi
fi

rm -rf -- "$dir"
echo "removed $dir"
