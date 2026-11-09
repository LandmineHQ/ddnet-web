#!/bin/bash
# Syntax-check the Emscripten-only sources with g++ in the ddcheck container.
# Everything runs through docker compose (no ad-hoc `docker run`).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec docker compose -f compose.test.yml --profile test run --rm -T syntax-check
