#!/usr/bin/env bash
# encode-token.sh — Encode a raw bearer token into the OBV1 format that
# Observe BRUM (observe-brum.js) decodes at runtime.
#
# Usage:
#   ./tools/encode-token.sh <raw-token>
#   echo '<raw-token>' | ./tools/encode-token.sh
#
# Encoding chain (must stay in sync with decodeBrumToken in brum.js):
#   utf8(token) → reverse-bytes → base64 → reverse-string → base64 → 'OBV1:' + result

set -euo pipefail

if [[ $# -gt 0 ]]; then
    raw="$1"
else
    raw="$(cat)"
fi
raw="${raw#"${raw%%[![:space:]]*}"}"   # ltrim
raw="${raw%"${raw##*[![:space:]]}"}"   # rtrim

if [[ -z "$raw" ]]; then
    echo "error: no token provided" >&2
    echo "usage: $0 <raw-token>     (or pipe via stdin)" >&2
    exit 1
fi

reverse_bytes() {
    python3 -c "import sys; d=sys.stdin.buffer.read(); sys.stdout.buffer.write(d[::-1])"
}
reverse_string() {
    python3 -c "import sys; print(sys.stdin.read()[::-1], end='')"
}
b64() {
    base64 | tr -d '\n'
}

encoded="$(printf '%s' "$raw" | reverse_bytes | b64 | reverse_string | b64)"
printf 'OBV1:%s\n' "$encoded"
