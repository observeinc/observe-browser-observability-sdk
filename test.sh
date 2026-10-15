#!/usr/bin/env bash
# test.sh runs tests for Observe BRUM.
#
# Usage:
#   ./test.sh                   # Run non-functional (Jest) tests
#   ./test.sh --coverage        # Non-functional tests with coverage
#   ./test.sh --watch           # Non-functional tests, watch mode
#   ./test.sh --functional      # Run functional tests (Go, requires Docker)
#   ./test.sh --all             # Run non-functional then functional

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

COVERAGE=false
WATCH=false
SUITE="non-functional"

for arg in "$@"; do
    case "$arg" in
        --coverage) COVERAGE=true ;;
        --watch) WATCH=true ;;
        --functional) SUITE="functional" ;;
        --all) SUITE="all" ;;
        -h|--help)
            sed -n '2,9p' "$0"
            exit 0
            ;;
    esac
done

run_non_functional() {
    if [[ ! -d "$ROOT/node_modules" ]]; then
        echo "→ Installing dependencies..."
        npm install --silent
    fi

    echo "→ Running non-functional (Jest) tests..."
    if [[ "$WATCH" == "true" ]]; then
        npm run test:watch
    elif [[ "$COVERAGE" == "true" ]]; then
        npm run test:unit -- --coverage
    else
        npm run test:unit
    fi
}

run_functional() {
    echo "→ Building bundle for functional tests..."
    npm run build

    echo "→ Running functional tests (Docker + headless Chrome)..."
    set +e
    docker compose -f tests/functional/docker-compose.yml up \
        --abort-on-container-exit --exit-code-from gotest
    local status=$?
    set -e
    docker compose -f tests/functional/docker-compose.yml down >/dev/null 2>&1 || true
    return "$status"
}

case "$SUITE" in
    non-functional) run_non_functional ;;
    functional)      run_functional ;;
    all)
        run_non_functional
        run_functional
        ;;
esac
