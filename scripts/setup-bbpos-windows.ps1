# Maps localemv.com to 127.0.0.1 so browsers reach local PaymentEngineExt (BBPOS)
# instead of the public IPv6 address. Run as Administrator:
#   npm run setup:bbpos
# or right-click PowerShell → Run as administrator, then run this script.

$ErrorActionPreference = "Stop"
$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$marker = "localemv.com"
$ipv4Entry = "127.0.0.1 localemv.com"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Update-HostsFile {
  if (-not (Test-IsAdmin)) {
    Write-Host "ERROR: Run PowerShell as Administrator to edit the hosts file." -ForegroundColor Red
    Write-Host "  Right-click PowerShell -> Run as administrator"
    Write-Host "  cd to this project, then: npm run setup:bbpos"
    return $false
  }

  $lines = Get-Content -Path $hostsPath -ErrorAction Stop
  $filtered = @()
  $hadIpv4 = $false

  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if ($trimmed -match "^\s*#" -or $trimmed -eq "") {
      $filtered += $line
      continue
    }
    if ($trimmed -notmatch [regex]::Escape($marker)) {
      $filtered += $line
      continue
    }
    # Drop any existing localemv.com line (IPv4 or IPv6); we add a clean IPv4 row below.
    if ($trimmed -match "^\s*127\.0\.0\.1\s+$marker(\s|$)") {
      $hadIpv4 = $true
    }
    Write-Host "Removing hosts entry: $trimmed"
  }

  if (-not $hadIpv4) {
    if ($filtered.Count -gt 0 -and $filtered[-1].Trim() -ne "") {
      $filtered += ""
    }
    $filtered += "# Diamant POS - force BBPOS (PaymentEngineExt) to IPv4 loopback"
    $filtered += $ipv4Entry
    Write-Host "Added: $ipv4Entry" -ForegroundColor Green
  } else {
    Write-Host "IPv4 hosts entry already present; removed duplicate/stale localemv.com lines." -ForegroundColor Green
    if ($filtered.Count -gt 0 -and $filtered[-1].Trim() -ne "") {
      $filtered += ""
    }
    $filtered += "# Diamant POS - force BBPOS (PaymentEngineExt) to IPv4 loopback"
    $filtered += $ipv4Entry
  }

  try {
    attrib -R $hostsPath 2>$null | Out-Null
    $text = ($filtered -join "`r`n").TrimEnd() + "`r`n"
    $temp = Join-Path $env:TEMP ("hosts-diamant-{0}.tmp" -f [guid]::NewGuid().ToString("n"))
    [System.IO.File]::WriteAllText($temp, $text, [System.Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath $temp -Destination $hostsPath -Force
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    Write-Host "Hosts file updated." -ForegroundColor Green
    return $true
  } catch {
    Write-Host "ERROR: Could not write hosts file: $_" -ForegroundColor Red
    Write-Host "Manual fix: run  notepad $hostsPath  and add this line:" -ForegroundColor Yellow
    Write-Host "  $ipv4Entry" -ForegroundColor Yellow
    return $false
  }
}

function Test-BbposAgent {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) {
    Write-Host "curl.exe not found; skipping BBPOS probe." -ForegroundColor Yellow
    return
  }

  Write-Host ""
  Write-Host "Probing https://localemv.com:8887/ (IPv4)..." -ForegroundColor Cyan
  try {
    $probe = & curl.exe -4 -k -s -S -m 10 -o NUL -w "HTTP %{http_code}, %{size_download} bytes" `
      https://localemv.com:8887/ 2>&1
    Write-Host $probe
  } catch {
    Write-Host "BBPOS probe failed: $_" -ForegroundColor Yellow
  }

  $proc = Get-Process -Name PaymentEngineExt -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Host "PaymentEngineExt is running (PID $($proc.Id))." -ForegroundColor Green
  } else {
    Write-Host "PaymentEngineExt is NOT running. Start Sola BBPOS from the system tray." -ForegroundColor Yellow
  }
}

Write-Host "Diamant POS - BBPOS Windows setup" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

$hostsOk = $false
try {
  $hostsOk = Update-HostsFile
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Manual fix: run  notepad $hostsPath  and add this line:" -ForegroundColor Yellow
  Write-Host "  $ipv4Entry" -ForegroundColor Yellow
}
if ($hostsOk) {
  Write-Host "Flushing DNS cache..."
  ipconfig /flushdns | Out-Null
}

Test-BbposAgent

Write-Host ""
if ($hostsOk) {
  Write-Host "Next steps:" -ForegroundColor Cyan
  Write-Host "  1. Fully quit and reopen Chrome (or Edge)."
  Write-Host "  2. Confirm PaymentEngineExt is running and the Cardknox API key is set."
  Write-Host "  3. Connect the Verifone P200, then run a test sale from the POS."
} else {
  Write-Host "Hosts file was not changed. Re-run this script in an elevated PowerShell." -ForegroundColor Yellow
}
