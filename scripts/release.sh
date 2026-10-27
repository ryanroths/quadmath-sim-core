#!/usr/bin/env bash
# quadmath-sim-core release. Writes release/ from a committed ref:
#
#   scripts/release.sh            # HEAD
#   scripts/release.sh v0.1.0     # a tag
#
# release/ holds what a consumer loads: the module, its JS wrapper
# (sim-core.js and cli-policy.js, which sim-core.js imports), the Air65
# airframe and the owner's Air65 Betaflight diff it flies with, NOTICE and
# LICENSE, and VERSION (git describe of the ref). Every
# file comes from the ref's tree, not the working tree, so a release is what
# was committed; the module is checked against the ref's committed sha256.
# Nothing is built here: dist/ is scripts/build.sh's.
#
# This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-HEAD}"
OUT=release

fail() { echo "release: $*" >&2; exit 1; }

git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || fail "no commit $REF"
VERSION="$(git describe --tags --always "$REF")"

# published path <- path in the ref's tree
FILES=(
  "sim-core.wasm:dist/sim-core.wasm"
  "sim-core.js:src/js/sim-core.js"
  "cli-policy.js:src/js/cli-policy.js"
  "airframes/air65.json:airframes/air65.json"
  "configs/air65-ryfly-2026-10-23.txt:configs/air65-ryfly-2026-10-23.txt"
  "NOTICE:NOTICE"
  "LICENSE:LICENSE"
)

rm -rf "$OUT"
mkdir -p "$OUT/airframes" "$OUT/configs"
for f in "${FILES[@]}"; do
  git cat-file -e "$REF:${f#*:}" 2>/dev/null || fail "$REF has no ${f#*:}"
  git show "$REF:${f#*:}" > "$OUT/${f%%:*}"
done
printf '%s\n' "$VERSION" > "$OUT/VERSION"

WANT="$(git show "$REF:dist/sim-core.wasm.sha256" | cut -d' ' -f1)"
HAVE="$(sha256sum "$OUT/sim-core.wasm" | cut -d' ' -f1)"
[ "$WANT" = "$HAVE" ] || fail "sim-core.wasm sha256 $HAVE, $REF commits $WANT"

echo "release: $OUT/ at $VERSION ($(git rev-parse --short "$REF^{commit}")), sim-core.wasm sha256 $HAVE"
