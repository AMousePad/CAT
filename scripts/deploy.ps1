param([string]$Dest)

$ErrorActionPreference = 'Stop'
function Get-ArtifactHash([string]$FilePath) {
    $stream = [System.IO.File]::OpenRead($FilePath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
    finally { $sha256.Dispose(); $stream.Dispose() }
}

$repoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $repoPath
try {
    $manifest = Get-Content -LiteralPath 'spindle.json' -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($Dest)) {
        $workspacePath = Split-Path -Parent $repoPath
        $Dest = Join-Path $workspacePath "Lumiverse/data/extensions/$($manifest.identifier)/repo"
    } elseif (-not [System.IO.Path]::IsPathRooted($Dest)) {
        $Dest = Join-Path $repoPath $Dest
    }
    $destinationPath = [System.IO.Path]::GetFullPath($Dest)
    $destinationManifestPath = Join-Path $destinationPath 'spindle.json'
    if (Test-Path -LiteralPath $destinationManifestPath) {
        $installedManifest = Get-Content -LiteralPath $destinationManifestPath -Raw | ConvertFrom-Json
        if ($installedManifest.identifier -ne $manifest.identifier) {
            throw "Destination contains a different extension: $($installedManifest.identifier)"
        }
    }

    Write-Host "[$($manifest.identifier)] building..."
    bun run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; deployment was not copied.' }

    $destinationDist = Join-Path $destinationPath 'dist'
    New-Item -ItemType Directory -Path $destinationDist -Force | Out-Null
    foreach ($artifact in @('dist/backend.js', 'dist/frontend.js', 'spindle.json', 'LICENSE', 'CREDITS.md')) {
        $targetPath = Join-Path $destinationPath $artifact
        Copy-Item -LiteralPath $artifact -Destination $targetPath -Force
        $sourceHash = Get-ArtifactHash (Join-Path $repoPath $artifact)
        $targetHash = Get-ArtifactHash $targetPath
        if ($sourceHash -ne $targetHash) { throw "Deployed file verification failed: $artifact" }
    }
    Write-Host "[$($manifest.identifier)] deployed version $($manifest.version) to $destinationPath"
    Write-Host "[$($manifest.identifier)] deployed file hashes match."
    Write-Host 'First install: use Import Local in Extensions, grant permissions, then enable.'
    Write-Host 'Already installed: disable and enable CAT, then refresh the browser.'
}
finally { Pop-Location }
