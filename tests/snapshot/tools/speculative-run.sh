#!/bin/bash
# Runs speculative-probe.mjs against a
# dev Zen with Gecko's own network defaults (speculative-prefs.js puts back
# what dev profiles turn off), in namespaces that keep every packet and
# lookup on this machine:
# - network: lo only, with 192.168.77.1 (the private target) and 203.0.113.10
#   (a public site) added to it, so connects to either land on the probe's
#   listeners;
# - mount: /etc/nsswitch.conf with "hosts: files". the Linux server's mdns4_minimal and
#   resolve reach the host's avahi and systemd-resolved over Unix sockets,
#   which a network namespace doesn't cut. /etc/hosts maps the probe's .local
#   names to 192.168.77.1, and resolv.conf points at loopback.
# Gecko logs its lookups and sockets (nsHostResolver, nsSocketTransport) into
# <out dir>.
#
#   tests/snapshot/tools/speculative-run.sh <profile name> <zen binary> <out dir> [vectors...]
set -euo pipefail
name=$1
zen=$2
out=$(realpath -m "$3")
shift 3
export SPEC_ARGS="$*"
here=$(cd "$(dirname "$0")/../../.." && pwd)
[[ $(uname) == Linux ]] || { echo "speculative-run: Linux only" >&2; exit 2; }
mkdir -p "$out"
ns="$out/ns"
mkdir -p "$ns"
printf 'passwd: files\ngroup: files\nshadow: files\nhosts: files\nnetworks: files\nprotocols: files\nservices: files\n' >"$ns/nsswitch.conf"
{
  echo "127.0.0.1 localhost"
  echo "::1 localhost"
  for n in zs-pc1 zs-pc2 zs-eh1 zs-dp1 zs-dp2 zs-dp3 zs-dp4 zs-dp5; do echo "192.168.77.1 $n.local"; done
} >"$ns/hosts"
echo "nameserver 127.0.0.1" >"$ns/resolv.conf"
# Zen's own defaults for what dev profiles turn off, then the caller's prefs.
cat "$here/tests/snapshot/tools/speculative-prefs.js" ${ZENIUS_DEV_PREFS:+"$ZENIUS_DEV_PREFS"} >"$out/prefs.js"
export ZENIUS_DEV_PREFS="$out/prefs.js"
export ZEN_BIN=$zen SPEC_NAME=$name SPEC_OUT=$out SPEC_NS=$ns SPEC_HERE=$here
exec unshare -rnm sh -c '
  mount --bind "$SPEC_NS/nsswitch.conf" /etc/nsswitch.conf &&
  mount --bind "$SPEC_NS/hosts" /etc/hosts &&
  mount --bind "$SPEC_NS/resolv.conf" /etc/resolv.conf &&
  ip link set lo up &&
  ip addr add 192.168.77.1/32 dev lo &&
  ip addr add 203.0.113.10/32 dev lo &&
  cd "$SPEC_HERE" &&
  export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH &&
  MOZ_LOG=timestamp,sync,nsHostResolver:5,nsSocketTransport:5 MOZ_LOG_FILE="$SPEC_OUT/moz.log" \
    scripts/zen-dev.sh "$SPEC_NAME" start >"$SPEC_OUT/start.log" 2>&1 &&
  ZENIUS_INSTANCE="$SPEC_NAME" timeout 900 node tests/snapshot/tools/speculative-probe.mjs $SPEC_ARGS >"$SPEC_OUT/result.json" 2>"$SPEC_OUT/probe.err"
  rc=$?
  scripts/zen-dev.sh "$SPEC_NAME" stop >>"$SPEC_OUT/start.log" 2>&1
  exit $rc
'
