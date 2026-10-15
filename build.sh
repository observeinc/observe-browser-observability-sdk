#!/usr/bin/env bash
# This script builds the Observe BRUM bundle.
#
# esbuild bundles and minifies the OTel JS dependencies into a single IIFE.
#
# Build-time defines passed via esbuild --define:
#   __BRUM_VERSION__: esbuild stamps this value into the bundle. The bundle
#   emits it as a resource attribute.
#
# Usage:
#   ./build.sh                          # prod build (minify)
#   ./build.sh --dev                    # dev build (no minify, sourcemap)
#   VERSION=1.2.3 ./build.sh            # stamp a specific version
#   OUT=path/to/observe-brum.js ./build.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_MODE="false"
for arg in "$@"; do
    case "$arg" in
        --dev) DEV_MODE="true" ;;
        -h|--help)
            sed -n '2,13p' "$0"
            exit 0
            ;;
    esac
done

# Version: env var > package.json > fallback
if [[ -z "${VERSION:-}" ]]; then
    VERSION="$(node -e "process.stdout.write(require('$ROOT/package.json').version)" 2>/dev/null || echo '0.0.1')"
fi

# Dev builds: stamp version with Zulu time to seconds
if [[ "$DEV_MODE" == "true" ]]; then
    VERSION="${VERSION}-$(date -u +%Y%m%dT%H%M%SZ)"
fi

SRC="$ROOT/src/brum.js"
PKG_DIR="$ROOT"
OUT="${OUT:-$ROOT/dist/observe-brum.js}"

echo "→ Observe BRUM build"
echo "  version:  $VERSION"
echo "  source:   $SRC"
echo "  output:   $OUT"
echo "  dev mode: $DEV_MODE"
echo

if [[ ! -d "$PKG_DIR/node_modules" ]]; then
    echo "→ Installing dependencies"
    (cd "$PKG_DIR" && npm install --silent)
fi

mkdir -p "$(dirname "$OUT")"

# esbuild: bundle + minify into OUT directly (UMD format).
ESBUILD_FLAGS=(
    "$SRC"
    --bundle
    --platform=browser
    --format=iife
    --target=es2020
    "--outfile=$OUT"
    "--define:__BRUM_VERSION__=\"$VERSION\""
)
if [[ "$DEV_MODE" == "true" ]]; then
    ESBUILD_FLAGS+=( --sourcemap "--define:__BRUM_DEV__=true" )
else
    ESBUILD_FLAGS+=( --minify "--define:__BRUM_DEV__=false" )
fi

echo "→ esbuild (UMD)"
(cd "$PKG_DIR" && npx --yes esbuild "${ESBUILD_FLAGS[@]}")

BYTES="$(wc -c < "$OUT" | tr -d ' ')"
echo "→ Build complete: $OUT (${BYTES} bytes)"
