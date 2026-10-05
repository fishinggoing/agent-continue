# Uses an installed Go toolchain, or the local portable toolchain when present.
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repository '.agent-continue'
$goCommand = Get-Command go -ErrorAction SilentlyContinue | Select-Object -First 1
$goExecutable = if ($goCommand) { $goCommand.Source } else { Join-Path $runtimeRoot 'toolchains\go\bin\go.exe' }
if (-not (Test-Path -LiteralPath $goExecutable)) { throw 'Install Go 1.26 or newer from https://go.dev/dl/ and reopen your terminal.' }
$variableNames = @('GOPATH', 'GOCACHE', 'GOTMPDIR', 'TEMP', 'TMP')
$previous = @{}
foreach ($name in $variableNames) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  $env:GOPATH = Join-Path $runtimeRoot 'gopath'
  $env:GOCACHE = Join-Path $runtimeRoot 'gocache'
  $tempRoot = Join-Path $runtimeRoot 'go-tmp'
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $env:GOTMPDIR = $tempRoot
  $env:TEMP = $tempRoot
  $env:TMP = $tempRoot
  & $goExecutable @args
  $goExitCode = $LASTEXITCODE
} finally {
  foreach ($name in $variableNames) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
exit $goExitCode
