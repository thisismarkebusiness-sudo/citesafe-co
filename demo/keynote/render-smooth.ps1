# Render CiteSafe keynote @ 24fps (smooth mouse) then stitch + mix audio.
$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ffmpeg = (Get-Command ffmpeg.exe -ErrorAction Stop).Source
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$frames = Join-Path $root "frames"
$anim = (Resolve-Path (Join-Path $root "anim.html")).Path
$uriBase = ([System.Uri]::new($anim)).AbsoluteUri

$FPS = 24
$DURATION = 52
$TOTAL = $FPS * $DURATION

New-Item -ItemType Directory -Force -Path $frames | Out-Null
Get-ChildItem $frames -Filter "f*.png" -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "Rendering $TOTAL frames @ ${FPS}fps"
Write-Host "URI $uriBase"
$sw = [Diagnostics.Stopwatch]::StartNew()

for ($i = 0; $i -lt $TOTAL; $i++) {
  $out = Join-Path $frames ("f{0:D4}.png" -f $i)
  $url = "${uriBase}?f=$i"
  $p = Start-Process -FilePath $chrome -ArgumentList @(
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1920,1080",
    "--screenshot=$out",
    $url
  ) -Wait -PassThru -WindowStyle Hidden
  if (-not (Test-Path $out)) {
    # retry once
    Start-Sleep -Milliseconds 200
    Start-Process -FilePath $chrome -ArgumentList @(
      "--headless=new","--disable-gpu","--hide-scrollbars",
      "--force-device-scale-factor=1","--window-size=1920,1080",
      "--screenshot=$out", $url
    ) -Wait -WindowStyle Hidden | Out-Null
  }
  if (-not (Test-Path $out)) { throw "Missing frame $i" }

  if (($i + 1) % 48 -eq 0 -or $i -eq 0) {
    $rate = ($i + 1) / [Math]::Max(0.001, $sw.Elapsed.TotalSeconds)
    $eta = [int](($TOTAL - $i - 1) / [Math]::Max(0.001, $rate))
    Write-Host ("  {0}/{1}  {2:n1} f/s  eta ~{3}s" -f ($i + 1), $TOTAL, $rate, $eta)
  }
}

Write-Host "Rendered $TOTAL frames in $([int]$sw.Elapsed.TotalSeconds)s"

$silent = Join-Path $root "keynote_anim_silent.mp4"
Write-Host "Stitching silent video..."
& $ffmpeg -y -framerate $FPS -i (Join-Path $frames "f%04d.png") `
  -c:v libx264 -pix_fmt yuv420p -crf 18 -preset veryfast `
  -movflags +faststart $silent
if ($LASTEXITCODE -ne 0) { throw "ffmpeg stitch failed" }

$clk = Join-Path $root "_clk.wav"
$scoreFinal = Join-Path $root "_score_final.m4a"
$outMp4 = Join-Path (Split-Path $root) "keynote.mp4"

Write-Host "Building click score..."
& $ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=mono" -t $DURATION `
  -af "aeval='0.55*sin(2*PI*1600*t)*exp(-55*mod(t+0.001,100))*((between(t,12.55,12.8)+between(t,29.4,29.65)+between(t,31.05,31.3)+between(t,32.4,32.65)+between(t,33.75,34)+between(t,35.1,35.35)+between(t,36.45,36.7)+between(t,40.7,40.95)))+0.22*sin(2*PI*900*t)*exp(-18*mod(t,0.5))*(between(t,14,23.5))'" `
  -c:a pcm_s16le $clk
if ($LASTEXITCODE -ne 0) { throw "click score failed" }

Write-Host "Mixing ambient + clicks..."
& $ffmpeg -y `
  -f lavfi -i "sine=frequency=196:duration=$DURATION" `
  -f lavfi -i "sine=frequency=247:duration=$DURATION" `
  -f lavfi -i "sine=frequency=82:duration=$DURATION" `
  -f lavfi -i "anoisesrc=color=pink:d=$DURATION:amplitude=0.25" `
  -i $clk `
  -filter_complex "[0]volume=0.035,afade=t=in:st=8:d=3,afade=t=out:st=48:d=3[a1];[1]volume=0.025,afade=t=in:st=10:d=3,afade=t=out:st=47:d=3[a2];[2]volume=0.07,lowpass=f=110,afade=t=in:st=8:d=3,afade=t=out:st=48:d=3[a3];[3]volume=0.018,lowpass=f=380,afade=t=in:st=8:d=4[a4];[4]volume=1.1[a5];[a1][a2][a3][a4][a5]amix=inputs=5:normalize=0,alimiter=limit=0.78,volume=1.25[aout]" `
  -map "[aout]" -c:a aac -b:a 192k $scoreFinal
if ($LASTEXITCODE -ne 0) { throw "mix failed" }

Write-Host "Muxing final keynote.mp4..."
& $ffmpeg -y -i $silent -i $scoreFinal -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart $outMp4
if ($LASTEXITCODE -ne 0) { throw "mux failed" }

$posterSrc = Join-Path $frames "f0840.png"
if (Test-Path $posterSrc) {
  Copy-Item $posterSrc (Join-Path (Split-Path $root) "keynote-poster.png") -Force
}

Write-Host "DONE size=$((Get-Item $outMp4).Length) elapsed=$([int]$sw.Elapsed.TotalSeconds)s"
