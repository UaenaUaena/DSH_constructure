#!/usr/bin/env bash
# POSIX entry point; the installer itself is install.mjs so Windows, macOS, and
# Linux all run exactly the same steps.
#
#   ./install.sh                 # install into $DSH_PROFILE, else "web"
#   ./install.sh --profile desktop
#   ./install.sh --dry-run
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/install.mjs" "$@"
