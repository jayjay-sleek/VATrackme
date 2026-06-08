param()
$srcRoot = Get-Location
$outDir = Join-Path $srcRoot 'temp_clean'
if (Test-Path $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null
$excludePatterns = @('installer-final*','installer-signed*','installer-next','installer*','installer-signed-psc*','installer-signed-psc2*','build\\codesign.pfx','build\\icon.ico')
$tracked = Get-Content (Join-Path $srcRoot 'files_all.txt')
foreach ($f in $tracked) {
  $skip = $false
  foreach ($p in $excludePatterns) {
    if ($f -like $p) { $skip = $true; break }
  }
  if ($skip) { continue }
  $srcPath = Join-Path $srcRoot $f
  $destPath = Join-Path $outDir $f
  $destDir = Split-Path $destPath
  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  Copy-Item -LiteralPath $srcPath -Destination $destPath -Force
}
Write-Output \"Created clean tree at $outDir\"
