# Piano — one command to bring everything up.
#
#   tilt up
#   → http://localhost:10350   (Tilt UI: logs + status for every service)
#   → http://localhost:3009    (Piano)
#
# Architecture: most of the stack runs as Docker containers via
# docker-compose.yml (postgres, nats, temporal, backend, worker, frontend,
# caddy, sish). The daemon runs natively on the host — it manages Podman
# machines and needs Linux kernel features (overlayfs, BTRFS, cgroup-freezer)
# that don't survive being wrapped in another container cleanly.
#
# Prereqs (install.sh handles them): docker, tilt, go, podman + crun +
# fuse-overlayfs + uidmap + btrfs-progs, passwordless or pre-warmed sudo.
#
# macOS: run this inside an OrbStack Linux VM (`orb shell piano`).

if not os.path.exists('.env'):
  fail('.env is missing — run ./scripts/install.sh (or ./scripts/generate-secrets.sh) first.')

# Container stack: postgres, nats, temporal, temporal-ui, sish, backend,
# temporal-worker, frontend, caddy. Each appears as its own Tilt resource
# with logs and a restart button.
docker_compose('./docker-compose.yml')

# Daemon runs on the host (root, sudo). The shell script handles the build,
# pre-flight kill of any leftover daemon, env/token loading from .env, and
# exec-ing under sudo for clean signal propagation from Tilt.
local_resource(
  'daemon',
  serve_cmd='bash ./scripts/run-daemon.sh',
  deps=['daemon', 'scripts/run-daemon.sh'],
  labels=['daemon'],
  resource_deps=['backend', 'sish'],
)
