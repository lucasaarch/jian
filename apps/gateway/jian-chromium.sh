#!/bin/sh
# Chromium for pages an agent inspects. Its own sandbox needs user namespaces, which a container
# with the default seccomp profile refuses, so Landlock confines it as it does an agent's commands:
# nothing beneath /app or /home, and no ptrace of the gateway. jian-sandbox fails closed: without
# Landlock the browser does not start, and the inspection says so.
exec /usr/local/bin/jian-sandbox \
  --ro /usr --ro /bin --ro /sbin --ro /lib --ro /lib64 --ro /etc --ro /proc --ro /sys \
  --ro /var/cache \
  --rw /tmp --rw /dev \
  -- /usr/bin/chromium "$@"
