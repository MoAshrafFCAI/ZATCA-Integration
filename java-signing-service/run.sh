#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Build and run the ZATCA signing service.
#
# WHY THIS SCRIPT EXISTS: the Java service reads configuration via
# System.getenv() — real process environment variables. Unlike the Node side
# (which uses dotenv), Java does NOT read a .env file on its own. Copying
# .env.example to .env and running `java ...` directly will fail with
# "Missing required environment variable: ZATCA_SDK_JAR_PATH".
#
# This script loads .env into the environment first, then runs.
#
# Windows equivalent: see run.ps1
# -----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ERROR: no .env file here. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Load .env into the environment (ignores blank lines and # comments).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Requires a JDK (javac), not just a JRE. Check before the confusing error.
if ! command -v javac >/dev/null 2>&1; then
  echo "ERROR: javac not found. You have a JRE but need a full JDK to compile." >&2
  echo "       Install one (e.g. OpenJDK 11-17) and make sure javac is on PATH." >&2
  exit 1
fi

mkdir -p out
echo "Compiling..."
javac -d out ./*.java

echo "Starting signing service on port ${PORT:-8080}..."
exec java -cp out com.zatca.signing.ZatcaSigningService
