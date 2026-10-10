#!/usr/bin/env bash
#
# Verify saving end to end against the real built application.
#
# This is the only check that reaches the actual IPC boundary. The Rust unit
# tests call `save_document` directly, and the browser checks stub the bridge, so
# neither can see a mismatch between the arguments the frontend sends and the
# parameters the command declares. That is how the save button came to fail on
# every press while every other check passed.
#
# The app is driven through System Events, which needs Accessibility permission
# for whatever is running this script. If that is not granted nothing is typed,
# the marker never appears, and the script fails — which is the honest outcome.
#
# Usage: scripts/verify-save-in-app.sh [path/to/Moda.app]

set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Moda.app}"
WORK_DIR="$(mktemp -d /tmp/moda-save-e2e.XXXXXX)"
DOCUMENT="$WORK_DIR/target.md"

cleanup() {
  pkill -f "Moda.app/Contents/MacOS/moda" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

[ -d "$APP" ] || { echo "FAIL: no application at $APP" >&2; exit 1; }
# `open -a` needs an absolute path; a relative one is read as an app name.
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"

printf '# 保存端到端验证\n\n初始内容。\n' > "$DOCUMENT"
BEFORE_SIZE=$(wc -c < "$DOCUMENT" | tr -d ' ')

pkill -f "Moda.app/Contents/MacOS/moda" 2>/dev/null || true
sleep 2
open -a "$APP" "$DOCUMENT"
sleep 9

echo "document:   $DOCUMENT"
echo "before:     $BEFORE_SIZE bytes"

# The caret starts at the document's beginning, so a bare keystroke would land in
# the heading. Moving to the end first puts the typed marker in the body, where a
# user would type it. Mouse clicks are avoided deliberately: System Events has no
# reliable click-at-point command, and positioning by keystroke is deterministic.
#
# The marker is letters only. `keystroke` does not pass punctuation through
# faithfully — an underscore arrives as "a" — and a marker that cannot be typed
# exactly would fail for a reason unrelated to saving.
osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "Moda"
    set frontmost to true
  end tell
  delay 1
  key code 124 using command down
  delay 1
  key code 36
  delay 1
  keystroke "SAVEMARKEROK"
  delay 1
  -- Save. `keystroke` with a modifier delivers the letter on its own as well as
  -- the chord, which would leave a stray character in the document; `key code 1`
  -- is the physical S key and sends only the chord.
  key code 1 using {command down}
end tell
APPLESCRIPT

sleep 4
AFTER_SIZE=$(wc -c < "$DOCUMENT" | tr -d ' ')

echo "after:      $AFTER_SIZE bytes"
echo "contents:"
cat "$DOCUMENT"
echo

if grep -qF "SAVEMARKEROK" "$DOCUMENT"; then
  echo "PASS: text typed into the running app was saved to disk by the real command."
  exit 0
fi

echo "FAIL: the marker is not in the file." >&2
if [ "$AFTER_SIZE" = "$BEFORE_SIZE" ]; then
  echo "      The file did not change at all." >&2
fi
echo "      If the document is also unchanged on screen, the likely cause is that" >&2
echo "      this terminal lacks Accessibility permission, so System Events could" >&2
echo "      not send the keystrokes." >&2
exit 1
