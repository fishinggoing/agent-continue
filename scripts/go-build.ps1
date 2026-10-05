param([string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repository '.agent-continue\builds\ai-cli-foundations' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$previousTargetOS = $env:GOOS
$previousTargetArch = $env:GOARCH
$previousCgo = $env:CGO_ENABLED
$reports = @()
try {
  $env:GOARCH = 'amd64'
  $env:CGO_ENABLED = '0'
  foreach ($target in @('windows', 'linux')) {
    $env:GOOS = $target
    $filename = if ($target -eq 'windows') { 'agent-continue-windows-amd64.exe' } else { 'agent-continue-linux-amd64' }
    $path = Join-Path $OutputDirectory $filename
    Push-Location $repository
    try {
      & (Join-Path $PSScriptRoot 'go.ps1') build -trimpath -o $path ./cmd/agent-continue
      if ($LASTEXITCODE -ne 0) { throw "Go build failed for $target" }
    } finally { Pop-Location }
    $reports += [ordered]@{ target = "$target/amd64"; path = $path; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); cgo = $false }
  }
} finally {
  $env:GOOS = $previousTargetOS
  $env:GOARCH = $previousTargetArch
  $env:CGO_ENABLED = $previousCgo
}
$reports | ConvertTo-Json
