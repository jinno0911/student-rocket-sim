# ロケット シミュレーターを PowerShell から実行する。
#   .\sim.ps1                      既定の機体で飛行シミュレーションを実行し、結果を表示
#   .\sim.ps1 -Debug               Debug 諸元（団体入力シートのサンプル）で実行
#   .\sim.ps1 -Set @{ mI = 800; launchAngle = 80 }   設定を上書きして実行（キーは設定保存 JSON と同じ）
#   .\sim.ps1 -Config cfg.json     アプリの「設定保存」で書き出した JSON で実行
#   .\sim.ps1 -Json                結果を JSON で出力（他のスクリプトに渡す用）
#   .\sim.ps1 -Open                画面付きのアプリを開く（サーバーを起動し、Ctrl+C で止める）
param([switch]$Debug, [hashtable]$Set, [string]$Config, [switch]$Json, [switch]$Open, [int]$Port = 8775)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$base = "http://localhost:$Port"
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$python = @('C:\Users\jinno\AppData\Local\Programs\Python\Python312\python.exe') + @((Get-Command python -ErrorAction SilentlyContinue).Source) |
          Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

function Test-Server { try { (Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }
function Start-AppServer {
  if (Test-Server) { return $null }
  if (-not $python) { throw 'Python が見つかりません' }
  $p = Start-Process $python -ArgumentList '-m', 'http.server', $Port -WorkingDirectory $root -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 20 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Server)) { $p | Stop-Process -Force; throw "サーバーを起動できませんでした（port $Port）" }
  $p
}

# --- 画面付きで開く ---
if ($Open) {
  $server = Start-AppServer
  Start-Process "$base/"
  Write-Host "ロケット シミュレーターを開きました: $base/" -ForegroundColor Green
  if ($server) {
    Write-Host 'このウィンドウを閉じるか Ctrl+C でサーバーを止めます。'
    try { Wait-Process -Id $server.Id } finally { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  } else { Write-Host '（すでに起動中のサーバーを使いました）' }
  return
}

# --- コマンドラインで実行 ---
if (-not $chrome) { throw 'Chrome が見つかりません（ヘッドレス実行に使います）' }
$over = @{}
if ($Config) { (Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $over[$_.Name] = $_.Value } }
if ($Set) { $Set.GetEnumerator() | ForEach-Object { $over[$_.Key] = $_.Value } }
$url = "$base/test/cli.html?" + $(if ($Debug) { 'preset=debug&' } else { '' }) +
       $(if ($over.Count) { 'cfg=' + [uri]::EscapeDataString(($over | ConvertTo-Json -Compress -Depth 5)) } else { '' })

$server = Start-AppServer
$prof = Join-Path ([IO.Path]::GetTempPath()) ('rocketsim-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $prof | Out-Null
try {
  $dom = Join-Path $prof 'dom.html'
  $p = Start-Process $chrome -PassThru -WindowStyle Hidden -RedirectStandardOutput $dom -RedirectStandardError (Join-Path $prof 'err.txt') `
       -ArgumentList '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', "--user-data-dir=$prof", '--virtual-time-budget=20000', '--dump-dom', $url
  if (-not $p.WaitForExit(120000)) { $p.Kill(); throw 'シミュレーションがタイムアウトしました' }
  $m = [regex]::Match((Get-Content $dom -Raw -Encoding UTF8), '<pre id="out">(.*?)</pre>', 'Singleline')
  if (-not $m.Success) { throw '結果を読み取れませんでした' }
  $r = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) | ConvertFrom-Json
} finally {
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
}

if ($Json) { $r | ConvertTo-Json -Depth 6; return }
if (-not $r.ok) { Write-Host "計算エラー: $($r.error)" -ForegroundColor Red; exit 1 }
$s = $r.summary
function F($v, $d = 1) { if ($null -eq $v) { '—' } else { ([double]$v).ToString("F$d") } }
$rows = @(
  @('頂点高度',            (F $s.apogee_m 0),            'm'),
  @('頂点到達時刻',        (F $s.apogee_t_s),            's'),
  @('最大速度（上昇中）',  (F $s.maxV_mps 0),            'm/s'),
  @('最大マッハ数',        (F $s.maxMach 2),             ''),
  @('最大加速度（上昇中）',(F $s.maxAcc_G),              'G'),
  @('ランチクリア速度',    (F $s.railExit_V_mps),        'm/s'),
  @('作動終了時の速度',    (F $s.opEnd_V_mps 0),         'm/s'),
  @('1段目 開傘時対気速度',(F $s.deploy1_Va_mps),        'm/s'),
  @('着地時降下速度',      (F ([math]::Abs($s.landing_vz_mps))),        'm/s'),
  @('落下距離',            (F $s.landing_dist_m 0),      'm'),
  @('落下方位（真北）',    (F $s.landing_brgTrue_deg 0), '°'),
  @('飛行時間',            (F $s.flightEnd_t_s),         's'),
  @('ペイロード落下距離',  (F $s.payloadLanding_dist_m 0),'m')
)
Write-Host ''
$rows | ForEach-Object { Write-Host ('  {0,-22}{1,10} {2}' -f $_[0], $_[1], $_[2]) }
if ($r.review) { Write-Host ('  {0,-22}{1,10} %   / 非充填 {2} %' -f '静安定余裕 Fst（充填時）', (F $r.review.fstWet_pct 2), (F $r.review.fstDry_pct 2)) }
if ($r.assumedThrust) { Write-Host "`n  注意: 推力履歴は仮定（Isp 170 s）。審査提出には地上燃焼試験の推力履歴を使うこと" -ForegroundColor Yellow }
Write-Host ''
