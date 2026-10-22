#!/usr/bin/env bash
# quadmath-sim-core build. The only entry point that produces dist/.
#
#   scripts/build.sh                    # SC_LOOP_HZ=1000 -> dist/sim-core.wasm
#   SC_LOOP_HZ=2000 scripts/build.sh    # -> dist/sim-core-2000hz.wasm
#   SC_UPDATE_DIST=1 scripts/build.sh   # accept a new hash (after a source change)
#
# Byte-exact by design: one pinned emcc, relative paths only, a fixed
# SOURCE_DATE_EPOCH, no emcc environment overrides, Betaflight pinned and
# patched in a copy (vendor/ is read-only). The result is compared with the
# committed hash; dist/ changes only when they match or SC_UPDATE_DIST=1.
#
# This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
set -euo pipefail
cd "$(dirname "$0")/.."

EMCC_WANT='3.1.61 (67fa4c16496b157a7fc3377afd69ee0445e8a6e3)'
BF_WANT='77d01ba3b76a22909d5f09cb0628820141f95eaa'
SC_LOOP_HZ="${SC_LOOP_HZ:-1000}"
SC_UPDATE_DIST="${SC_UPDATE_DIST:-0}"

fail() { echo "build: $*" >&2; exit 1; }

# Environment variables emcc honours that would change the bytes.
for v in EMCC_CFLAGS EMCC_FORCE_STDLIBS EMCC_ONLY_FORCED_STDLIBS EMCC_DEBUG EMMAKEN_CFLAGS EMCC_LOCAL_PORTS; do
  [ -z "${!v:-}" ] || fail "refusing to build with $v set"
done

if ! command -v emcc >/dev/null 2>&1; then
  for d in "${EMSDK:-}" "$HOME/emsdk"; do
    if [ -n "$d" ] && [ -f "$d/emsdk_env.sh" ]; then
      # shellcheck disable=SC1091
      source "$d/emsdk_env.sh" >/dev/null 2>&1 || true
      break
    fi
  done
fi
EMCC_HAVE="$(emcc --version 2>/dev/null | head -1 || true)"
case "$EMCC_HAVE" in
  *"$EMCC_WANT"*) ;;
  *) fail "need emcc $EMCC_WANT, have: ${EMCC_HAVE:-none}" ;;
esac

[[ "$SC_LOOP_HZ" =~ ^[1-9][0-9]*$ ]] || fail "SC_LOOP_HZ must be a decimal integer without leading zeros"
[ "$SC_LOOP_HZ" -ge 1000 ] && [ "$SC_LOOP_HZ" -le 8000 ] || fail "SC_LOOP_HZ must be 1000..8000"
[ $((1000000 % SC_LOOP_HZ)) -eq 0 ] || fail "SC_LOOP_HZ must divide 1000000 (whole-microsecond ticks)"

BF_HAVE="$(git -C vendor/betaflight rev-parse HEAD 2>/dev/null || true)"
[ "$BF_HAVE" = "$BF_WANT" ] || fail "vendor/betaflight is at ${BF_HAVE:-nothing}, need $BF_WANT (4.5.1)"
[ -z "$(git -C vendor/betaflight status --porcelain)" ] || fail "vendor/betaflight has local changes; Betaflight is read-only"

if [ "$SC_LOOP_HZ" = 1000 ]; then NAME=sim-core.wasm; else NAME="sim-core-${SC_LOOP_HZ}hz.wasm"; fi

export SOURCE_DATE_EPOCH=1700000000
export LC_ALL=C

BF=build/bf
rm -rf build
mkdir -p "$BF/src" "$BF/lib/main" build/obj/bf build/obj/sc dist
cp -R vendor/betaflight/src/main "$BF/src/main"
cp -R vendor/betaflight/lib/main/dyad "$BF/lib/main/dyad"
for p in patches/*.patch; do
  out="$(patch -p1 -d "$BF" --batch --forward --fuzz=0 --no-backup-if-mismatch < "$p")" || fail "patch $p did not apply: $out"
  case "$out" in *offset*|*fuzz*) fail "patch $p applied inexactly: $out" ;; esac
done

CFLAGS_COMMON=(-std=gnu17 -O2 -fno-fast-math -ffp-contract=off -ffunction-sections -fdata-sections -fblocks)
DEFS_BF=(-DSIMULATOR_BUILD -DCLOUD_BUILD -D_GNU_SOURCE '-D__TARGET__="QMSC"' '-D__REVISION__="77d01ba"' '-D__FORKNAME__="betaflight"' "-DSC_LOOP_HZ=$SC_LOOP_HZ")
INC_BF=(-I "$BF/src/main" -I target/QMSC -I "$BF/lib/main/dyad")

compile() { # src obj [extra...]
  local src="$1" obj="$2"; shift 2
  emcc -c "$src" "${CFLAGS_COMMON[@]}" "${DEFS_BF[@]}" "${INC_BF[@]}" "$@" -o "$obj"
}

OBJS=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in \#*) continue ;; esac
  o="build/obj/bf/$(printf '%s' "${f%.c}" | tr '/' '_').o"
  compile "$BF/src/main/$f" "$o"
  OBJS+=("$o")
done < scripts/bf-sources.txt

for f in src/glue/*.c src/plant/*.c; do
  [ -e "$f" ] || continue
  o="build/obj/sc/$(printf '%s' "${f%.c}" | tr '/' '_').o"
  compile "$f" "$o" -I src -Wall -Wextra -Wno-unused-parameter
  OBJS+=("$o")
done

emcc "${OBJS[@]}" -O2 --no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=16777216 -sSTACK_SIZE=262144 -sERROR_ON_UNDEFINED_SYMBOLS=1 \
  -o "build/$NAME"

HASH="$(sha256sum "build/$NAME" | cut -d' ' -f1)"
COMMITTED="$(git show "HEAD:dist/$NAME.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
if [ -n "$COMMITTED" ] && [ "$COMMITTED" != "$HASH" ] && [ "$SC_UPDATE_DIST" != 1 ]; then
  echo "build: build/$NAME is $HASH but the committed dist/$NAME.sha256 is $COMMITTED" >&2
  echo "build: dist/ left unchanged; rerun with SC_UPDATE_DIST=1 to accept a deliberate source change" >&2
  exit 2
fi
cp "build/$NAME" "dist/$NAME"
(cd dist && sha256sum "$NAME" > "$NAME.sha256")
echo "build: dist/$NAME $(stat -c %s "dist/$NAME") bytes, sha256 $HASH, SC_LOOP_HZ=$SC_LOOP_HZ${COMMITTED:+, matches committed: $([ "$COMMITTED" = "$HASH" ] && echo yes || echo "no (updated)")}"
