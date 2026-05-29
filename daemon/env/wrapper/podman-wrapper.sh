#!/bin/sh
# Piano podman/docker wrapper.
# Exec sessions run as the host user (--user uid:gid), but nested podman
# needs root for rootful mode. sudo escalates back to container root.
exec sudo /usr/bin/podman "$@"
