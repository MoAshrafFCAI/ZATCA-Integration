# -----------------------------------------------------------------------------
# Build and run the ZATCA signing service (Windows / PowerShell).
#
# WHY THIS SCRIPT EXISTS: the Java service reads configuration via
# System.getenv() — real process environment variables. Unlike the Node side
# (which uses dotenv), Java does NOT read a .env file on its own. Running
# `java ...` directly after only creating a .env will fail with
# "Missing required environment variable: ZATCA_SDK_JAR_PATH".
#
# Usage:   .\run.ps1
# (If PowerShell blocks it, see the execution-policy note in the README.)
# -----------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
    Write-Error "No .env file here. Copy .env.example to .env and fill it in."
    exit 1
}

# Load .env into this process's environment.
Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
        $idx = $line.IndexOf("=")
        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        # Strip surrounding quotes if present
        if ($value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

# Requires a JDK (javac), not just a JRE.
if (-not (Get-Command javac -ErrorAction SilentlyContinue)) {
    Write-Error "javac not found. You have a JRE but need a full JDK to compile. Install OpenJDK 11-17 and ensure javac is on PATH."
    exit 1
}

New-Item -ItemType Directory -Force -Path "out" | Out-Null

Write-Host "Compiling..."
javac -d out (Get-ChildItem -Filter *.java | ForEach-Object { $_.FullName })

$port = if ($env:PORT) { $env:PORT } else { "8080" }
Write-Host "Starting signing service on port $port..."
java -cp out com.zatca.signing.ZatcaSigningService
