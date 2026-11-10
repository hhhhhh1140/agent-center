#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
exec python3 -B center.py --open --port 0
