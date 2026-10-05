param([string]$Output)

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $Output) {
  $Output = Join-Path $repository ('.agent-continue\baselines\go-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
}
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw 'Snapshot already exists; refusing to overwrite.' }
$files = @('go.mod', 'go.sum', 'scripts/go.ps1', 'scripts/go-build.ps1', 'scripts/go-source-snapshot.ps1')
foreach ($directory in @('cmd', 'internal')) {
  if (Get-ChildItem -LiteralPath (Join-Path $repository $directory) -Recurse -Attributes ReparsePoint) { throw 'Source snapshots must not traverse links.' }
  foreach ($item in (Get-ChildItem -LiteralPath (Join-Path $repository $directory) -Recurse -File)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Source snapshots must not include links.' }
    $relative = [IO.Path]::GetRelativePath($repository, $item.FullName).Replace('\', '/')
    if ($relative -match '\.(go|html|css|js)$' -or $relative -eq 'internal/server/web/lucide.LICENSE' -or $relative -in @('internal/domain/CONTRACT.md', 'internal/provider/PROTOCOL.md') -or $relative -match '^internal/(migrate|provider)/testdata/[^/]+\.(json|sse)$') {
      $files += $relative
    }
  }
}
[IO.Directory]::CreateDirectory((Split-Path -Parent $Output)) | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($Output, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($relative in ($files | Sort-Object -Unique)) {
    $entry = $archive.CreateEntry($relative)
    $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $source = [IO.File]::OpenRead((Join-Path $repository $relative))
    $destination = $entry.Open()
    try { $source.CopyTo($destination) } finally { $source.Dispose(); $destination.Dispose() }
  }
} finally { $archive.Dispose() }
[ordered]@{ path = $Output; sha256 = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant(); files = $files.Count; scope = 'Go source, synthetic fixtures, embedded web assets, Go launcher'; gitCommit = (& git -C $repository rev-parse HEAD) } | ConvertTo-Json
