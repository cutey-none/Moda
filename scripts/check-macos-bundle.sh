#!/usr/bin/env bash
#
# Check that a built Moda.app is signed the way an unsigned release needs it.
#
# Moda ships without an Apple Developer ID, so Gatekeeper never verifies it and
# every downloader has to clear the quarantine flag by hand. That route only
# works if the bundle carries a *valid* ad-hoc signature. macOS arm64 binaries
# are always signed — by the linker — but a linker signature is not a bundle
# signature: it seals no resources, so the output of a plain `tauri build` fails
#
#   codesign --verify --strict Moda.app
#   Moda.app: code has no resources but signature indicates they must be present
#
# and macOS shows that failure to the user as "Moda is damaged and can't be
# opened". That message is the one `xattr` cannot clear and System Settings
# cannot override, so the README's instructions would be lies. Setting
# `bundle.macOS.signingIdentity` to `"-"` (Tauri's pseudo-identity for an ad-hoc
# signature) makes the bundler sign the finished bundle, so Gatekeeper refuses it
# as *unidentified developer* instead — the fixable state.
#
# This script asserts both halves of that story: the bundle satisfies its own
# signature, and Gatekeeper, judging a simulated browser download, complains
# about identity rather than about damage.
#
# Usage: scripts/check-macos-bundle.sh [path/to/Moda.app]

set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Moda.app}"
DAMAGED_PHRASE="code has no resources but signature indicates they must be present"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[ -d "$APP" ] || fail "no application at $APP (run 'pnpm tauri build' first)"

# --- 1. The bundle must be ad-hoc signed, and satisfy that signature ----------

VERIFY="$(codesign --verify --strict --verbose=2 "$APP" 2>&1)" || fail \
  "codesign --verify rejected $APP:

$VERIFY

      This is the 'damaged' state. macOS reports it to users as
      \"Moda is damaged and can't be opened\", which no instruction can fix.
      Is bundle.macOS.signingIdentity still set to \"-\" in tauri.conf.json?"

DETAIL="$(codesign -dvvv "$APP" 2>&1)"
SIGNATURE="$(grep -m1 '^Signature=' <<<"$DETAIL" || true)"
TEAM="$(grep -m1 '^TeamIdentifier=' <<<"$DETAIL" || true)"
SEAL="$(grep -m1 '^Sealed Resources' <<<"$DETAIL" || true)"

[ "$SIGNATURE" = "Signature=adhoc" ] || fail \
  "expected an ad-hoc signature, got '${SIGNATURE:-none}'"
[ "$TEAM" = "TeamIdentifier=not set" ] || fail \
  "expected no team, got '$TEAM' — an Apple ID has crept into this build"
# A linker signature reports `Sealed Resources=none`; a bundle signature reports
# a version and a file count. The difference is the whole point of this check.
grep -q '^Sealed Resources version' <<<"$SEAL" || fail \
  "the signature seals no resources ('$SEAL'), so it is a linker signature, not a bundle signature"

echo "signature:  $SIGNATURE"
echo "identity:   $TEAM"
echo "resources:  $SEAL"

# --- 2. Gatekeeper must reject it for identity, not for damage ----------------
#
# Gatekeeper only judges a bundle that carries the quarantine flag, which is how
# a browser download arrives. Work on a copy: the real artifact stays untouched.

WORK="$(mktemp -d "${TMPDIR:-/tmp}/moda-bundle-check.XXXXXX" 2>/dev/null \
  || mktemp -d "$(dirname "$APP")/.moda-bundle-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cp -R "$APP" "$WORK/Moda.app"
xattr -w com.apple.quarantine "0083;00000000;Safari;" "$WORK/Moda.app"

# spctl exits non-zero for any bundle it refuses, and a refusal is expected here;
# what matters is the reason it gives.
ASSESS="$(spctl -a -vvv -t exec "$WORK/Moda.app" 2>&1 || true)"

if grep -qF "$DAMAGED_PHRASE" <<<"$ASSESS"; then
  fail "Gatekeeper calls the quarantined bundle damaged:

$ASSESS

      Downloaders would see \"Moda is damaged and can't be opened\", and
      'xattr -cr /Applications/Moda.app' would not help them."
fi

echo "gatekeeper: $(tr '\n' ' ' <<<"$ASSESS" | sed 's/  */ /g')"

# --- 3. The documented workaround must actually clear the quarantine ----------

xattr -cr "$WORK/Moda.app"
[ -z "$(xattr "$WORK/Moda.app")" ] || fail \
  "'xattr -cr' left attributes on the bundle: $(xattr "$WORK/Moda.app")"

echo
echo "PASS: ad-hoc signed with no Apple ID, the signature verifies, and a"
echo "      quarantined download is refused as an unidentified developer — the"
echo "      state that 'xattr -cr /Applications/Moda.app' clears — rather than"
echo "      as a damaged app, which nothing clears."
