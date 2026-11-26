#!/usr/bin/env bash
# The saved-card test (tests/input/handback.test.mjs, "…saved card…") on a
# Zen of its own. A saved card's number is encrypted with the OS keystore,
# which on Linux is the session's Secret Service (libsecret). So this Zen
# gets a private D-Bus session and a throwaway gnome-keyring in a temp dir,
# unlocked with an empty password, and nothing reaches the user's own
# keyring. Linux only: on the Mac it would be the
# login Keychain, which no test uses. tests/input/run.sh runs this after
# the suite, where the test skips.
#
#   tests/input/keyring.sh      instance "inputkeyring-<checkout suffix>"
#
# The private bus starts no service on demand: the keyring daemon started
# here is the only service on it, and GTK's helpers (portals, gvfs) never
# start. Before Zen starts, this checks that no secret service answered on
# the bus before ours, and that the one answering now is ours. The test
# itself checks first that its Zen's session bus is this one.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
if [[ $(uname -s) != Linux ]]; then
  echo "tests/input/keyring.sh: Linux only, skipped" >&2
  exit 0
fi
for tool in dbus-run-session dbus-send gnome-keyring-daemon; do
  if ! command -v "$tool" >/dev/null; then
    echo "tests/input/keyring.sh: no $tool, skipped" >&2
    exit 0
  fi
done
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_KEYRING_INSTANCE:-inputkeyring-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

if [[ ${ZENIUS_KEYRING_INSIDE:-} != 1 ]]; then
  # The user's session bus and keyrings, as their own programs find them.
  USER_BUS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus}
  USER_KEYRINGS=${XDG_DATA_HOME:-$HOME/.local/share}/keyrings
  # The dev Zen's zenius home: the caller's (tests/input/run.sh gives one),
  # or one of this run's own, which the inner half, in its own bus, inherits.
  . "$ROOT/tests/lib/scratch-home.sh"
  own_zenius_home keyring || exit 2
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/zen-input-keyring.XXXXXX")
  trap 'rm -rf "$TMP"; drop_own_zenius_home' EXIT
  mkdir -p "$TMP/data/keyrings" "$TMP/run"
  chmod 700 "$TMP/data/keyrings" "$TMP/run"
  # A session bus like the system's, without its service dirs.
  cat >"$TMP/bus.conf" <<'CONF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF
  XDG_DATA_HOME="$TMP/data" XDG_RUNTIME_DIR="$TMP/run" \
    ZENIUS_KEYRING_INSIDE=1 ZENIUS_KEYRING_TMP="$TMP" ZENIUS_USER_BUS="$USER_BUS" ZENIUS_USER_KEYRINGS="$USER_KEYRINGS" \
    dbus-run-session --config-file="$TMP/bus.conf" -- "${BASH_SOURCE[0]}" "$@"
  exit
fi

# Inside the private session.
TMP=$ZENIUS_KEYRING_TMP
refuse() {
  echo "tests/input/keyring.sh: $1, refusing" >&2
  exit 1
}
# Asks the bus itself about the name org.freedesktop.secrets.
bus() {
  dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    "org.freedesktop.DBus.$1" string:org.freedesktop.secrets 2>/dev/null || true
}
secrets() {
  dbus-send --session --print-reply --dest=org.freedesktop.secrets "$@"
}
if [[ -z ${DBUS_SESSION_BUS_ADDRESS:-} || $DBUS_SESSION_BUS_ADDRESS == "$ZENIUS_USER_BUS" ]]; then
  refuse "the session bus here is the user's"
fi
# A new bus has no secret service yet. The user's has theirs.
if [[ $(bus NameHasOwner) == *"boolean true"* ]]; then
  refuse "a secret service already answers on this bus"
fi

# gnome-keyring keeps a keyring with an empty password in this plain-text
# form. It's the default collection, and it unlocks without a prompt (there
# is no prompter on this bus).
printf '[keyring]\ndisplay-name=login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' >"$XDG_DATA_HOME/keyrings/login.keyring"
printf 'login' >"$XDG_DATA_HOME/keyrings/default"
gnome-keyring-daemon --foreground --components=secrets </dev/null >"$TMP/keyring.log" 2>&1 &
KEYRING=$!
cleanup() {
  "$DEV" "$NAME" stop >/dev/null 2>&1 || true
  kill "$KEYRING" 2>/dev/null || true
  wait "$KEYRING" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 100); do
  [[ $(bus NameHasOwner) == *"boolean true"* ]] && break
  sleep 0.1
done
owner=$(bus GetConnectionUnixProcessID | awk '$1 == "uint32" { print $2 }')
[[ $owner == "$KEYRING" ]] || refuse "the secret service on this bus isn't the throwaway keyring (pid ${owner:-none}, ours $KEYRING)"
secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.Unlock array:objpath:/org/freedesktop/secrets/collection/login >/dev/null
locked=$(secrets /org/freedesktop/secrets/aliases/default org.freedesktop.DBus.Properties.Get \
  string:org.freedesktop.Secret.Collection string:Locked)
if [[ $locked != *"boolean false"* ]]; then
  echo "tests/input/keyring.sh: the throwaway keyring didn't unlock: $(cat "$TMP/keyring.log")" >&2
  exit 1
fi

"$DEV" "$NAME" fresh >/dev/null
"$DEV" "$NAME" start
ZENIUS_INSTANCE=$NAME ZENIUS_KEYRING_BUS="$DBUS_SESSION_BUS_ADDRESS" ZENIUS_KEYRING_PID="$KEYRING" \
  ZENIUS_USER_BUS="$ZENIUS_USER_BUS" ZENIUS_USER_KEYRINGS="$ZENIUS_USER_KEYRINGS" \
  node --test --test-concurrency=1 --test-name-pattern="saved card" "$ROOT/tests/input/handback.test.mjs"
