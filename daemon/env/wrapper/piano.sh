#!/bin/sh
# piano — signal machine activity to the Piano host over the terminal stream.
#
# Idiomatic, no infrastructure: we print an OSC escape sequence to the
# controlling TTY. The Piano daemon owns the PTY master and reads the sequence
# straight out of the byte stream it already captures — no socket, no daemon
# API, no network. Anything running in the machine can call this: a build
# script, a human, or an agent told to do so. The host stores whatever
# <state>/<message> the caller chooses; it does not interpret them, which keeps
# the primitive at the machine level (agents are just one possible caller).
#
# IMPORTANT: only observed when run inside a Piano terminal pane. A plain SSH /
# "Open in IDE" session is a separate exec that bypasses the daemon's PTY
# reader, so signals emitted there are invisible (see daemon/activity.go).
#
# Usage:
#   piano signal <state> [message]   e.g. piano signal working "building frontend"
#   piano notify <message>           attention ping with a message
#   piano done [message]             mark the current unit of work finished
#
# The message is base64-encoded so it can contain spaces, ';' and newlines
# without breaking the OSC grammar; the daemon decodes it.

emit() {
	state=$1
	msg=$2
	b64=$(printf '%s' "$msg" | base64 | tr -d '\n')
	seq=$(printf '\033]1337;Piano;%s;%s\007' "$state" "$b64")
	if [ -w /dev/tty ]; then
		printf '%s' "$seq" >/dev/tty
	else
		printf '%s' "$seq"
	fi
}

case "$1" in
	signal | status) emit "${2:-working}" "${3:-}" ;;
	notify) emit "attention" "${2:-}" ;;
	done) emit "done" "${2:-}" ;;
	*)
		echo "usage: piano {signal <state> [msg] | notify <msg> | done [msg]}" >&2
		exit 2
		;;
esac
