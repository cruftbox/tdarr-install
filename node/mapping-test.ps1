# Mapping test: exercises the file operations a mapped Tdarr node performs over SMB.
# Leaves the test folder as it found it (only the original video).
param(
    [string]$Share = '\\bandersnatch\Video',
    [string]$Video = 'Murderbot.S01E03.WEB.H264-RBB.mp4',
    [string]$Ffprobe = '',
    [string]$Log = ''
)
$ErrorActionPreference = 'Stop'
$Test  = Join-Path $Share 'mapping-test'
$Cache = Join-Path $Share 'tdarr-cache'
$results = [System.Collections.Generic.List[string]]::new()
function Say($m) { $line = "{0:HH:mm:ss} {1}" -f (Get-Date), $m; $results.Add($line); Write-Output $line }
function Check($name, [scriptblock]$body) {
    try { $sw = [Diagnostics.Stopwatch]::StartNew(); $msg = & $body; $sw.Stop()
          Say ("PASS  {0}  ({1:N1}s) {2}" -f $name, $sw.Elapsed.TotalSeconds, $msg) }
    catch { Say ("FAIL  {0}: {1}" -f $name, $_.Exception.Message) }
}

Say "user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name) interactive=$([Environment]::UserInteractive) share=$Share"
$src = Join-Path $Test $Video

# Step 4: read
Check 'read full file' {
    $len = (Get-Item -LiteralPath $src).Length
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $h = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.Substring(0,16)
    "{0:N0} bytes, {1:N1} MB/s, sha256 {2}" -f $len, ($len/1MB/$sw.Elapsed.TotalSeconds), $h
}
if ($Ffprobe) {
    Check 'ffprobe over UNC' {
        $out = & $Ffprobe -v error -show_entries format=duration:stream=codec_name -of csv=p=0 $src 2>&1
        if ($LASTEXITCODE -ne 0) { throw "ffprobe exit $LASTEXITCODE $out" }
        ($out -join ' ')
    }
}

# Step 5: write to cache (1 GiB, incompressible)
$big = Join-Path $Cache 'write-test.bin'
Check 'write 1 GiB to cache' {
    $buf = [byte[]]::new(8MB); [Random]::new(1).NextBytes($buf)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $fs = [IO.File]::Create($big); try { for ($i=0; $i -lt 128; $i++) { $fs.Write($buf,0,$buf.Length) } } finally { $fs.Dispose() }
    "{0:N1} MB/s" -f (1024/$sw.Elapsed.TotalSeconds)
}
Check 'delete cache file' { Remove-Item -LiteralPath $big; if (Test-Path -LiteralPath $big) { throw 'still exists' } }

# Step 6 and 7: replace-original sequence, in the plain folder and in awkward-name folders
function Replace-Sequence($dir, $base) {
    $orig = Join-Path $dir "$base.mp4"
    if ($dir -ne $Test) { Check "seed copy into $dir" { New-Item -ItemType Directory -Force -Path $dir | Out-Null; Copy-Item -LiteralPath $src -Destination $orig } }
    $work = Join-Path $Cache "$base-TdarrCacheFile.mkv"
    Check "copy to cache ($base)"          { Copy-Item -LiteralPath $orig -Destination $work }
    Check "rename original to .old"        { Rename-Item -LiteralPath $orig -NewName "$base.mp4.old" }
    Check "move cache file to folder"      { Move-Item -LiteralPath $work -Destination (Join-Path $dir "$base.mkv.partial") }
    Check "rename to final .mkv"           { Rename-Item -LiteralPath (Join-Path $dir "$base.mkv.partial") -NewName "$base.mkv" }
    Check "verify final and .old exist"    { foreach ($f in "$base.mkv","$base.mp4.old") { if (-not (Test-Path -LiteralPath (Join-Path $dir $f))) { throw "missing $f" } }; (Get-ChildItem -LiteralPath $dir -File).Name -join ', ' }
    Check "delete new file"                { Remove-Item -LiteralPath (Join-Path $dir "$base.mkv") }
    Check "restore original name"          { Rename-Item -LiteralPath (Join-Path $dir "$base.mp4.old") -NewName "$base.mp4" }
    if ($dir -ne $Test) { Check "remove folder $dir" { Remove-Item -LiteralPath $dir -Recurse } }
}
$plainBase = [IO.Path]::GetFileNameWithoutExtension($Video)
Replace-Sequence $Test $plainBase
Replace-Sequence (Join-Path $Test "The Emperor's New Groove & Friends (2000) [Test]") "The Emperor's New Groove & Friends (2000)"
$longDir = Join-Path $Test ("Long Path Test " + ('x' * 120))
$longBase = "Long File Name " + ('y' * 110)
Say ("long path length: {0}" -f (Join-Path $longDir "$longBase.mp4.old").Length)
Replace-Sequence $longDir $longBase

$fails = ($results | Where-Object { $_ -match ' FAIL ' }).Count
Say "done: $fails failures"
if ($Log) { $results | Set-Content -LiteralPath $Log -Encoding utf8 }
