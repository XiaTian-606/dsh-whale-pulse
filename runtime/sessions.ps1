# 枚举可抓音频的应用：合并「有主窗口的进程」和「正在出声的音频会话」，
# 输出一行 JSON：[{"pid":1234,"name":"chrome","title":"...","active":true}, ...]

$ErrorActionPreference = 'Stop'

$libDir = Join-Path $env:TEMP 'whale-pulse-lib'
$naudio = Join-Path $libDir 'NAudio.dll'
if (-not (Test-Path $naudio)) {
  Write-Output '{"error":"naudio-missing"}'
  exit 1
}

try {
  [System.Reflection.Assembly]::LoadFrom($naudio) | Out-Null
} catch {
  Write-Output '{"error":"naudio-load-failed"}'
  exit 1
}

# ── 1. 收集所有设备上的音频会话状态（pid -> 是否 active） ──
$activePids = @{}
try {
  $en = New-Object NAudio.CoreAudioApi.MMDeviceEnumerator
  $devs = $en.EnumerateAudioEndPoints([NAudio.CoreAudioApi.DataFlow]::Render, [NAudio.CoreAudioApi.DeviceState]::Active)
  foreach ($dev in $devs) {
    $sessions = $dev.AudioSessionManager.Sessions
    for ($i = 0; $i -lt $sessions.Count; $i++) {
      $s = $sessions[$i]
      $procId = [int]$s.GetProcessID
      if ($procId -le 0) { continue }
      if ($s.State -eq 'AudioSessionStateActive') {
        $activePids[$procId] = $true
      } elseif (-not $activePids.ContainsKey($procId)) {
        $activePids[$procId] = $false
      }
    }
  }
} catch {
  # 枚举会话失败不致命：退化成「只看窗口进程」
}

# ── 2. 有主窗口的进程 + 有音频会话的进程，合并去重 ──
$windowsDir = $env:WINDIR
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try {
    if ($_.MainWindowTitle -eq '' -and -not $activePids.ContainsKey($_.Id)) { return $false }
    $procPath = $_.Path
    if ($null -ne $procPath -and $procPath.StartsWith($windowsDir, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    return $true
  } catch {
    # 进程刚好退出或拿不到属性：跳过它，别让整条枚举失败
    return $false
  }
}

$items = @()
foreach ($p in $procs) {
  try {
    $items += [pscustomobject]@{
      pid    = [int]$p.Id
      name   = [string]$p.ProcessName
      title  = [string]$p.MainWindowTitle
      active = [bool]$activePids[$p.Id]
    }
  } catch {
    # 单个进程取属性失败就跳过
  }
}

if ($items.Count -eq 0) {
  Write-Output '[]'
} else {
  $items | Sort-Object -Property @{ Expression = 'active'; Descending = $true }, @{ Expression = 'name'; Descending = $false } | ConvertTo-Json -Compress
}
