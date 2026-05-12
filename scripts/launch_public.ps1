param(
    [int]$Port = 8010,
    [string]$CondaEnv = "sanitize-ai",
    [string]$Subdomain = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$condaExe = "C:/Users/Administrator/miniconda3/Scripts/conda.exe"

if (-not (Test-Path $condaExe)) {
    throw "Conda executable not found at $condaExe"
}

Set-Location $repoRoot

# Stop any stale API process using the same port.
try {
    $staleConns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $staleConns) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
} catch {
    # Ignore if no listener exists.
}

$apiArgs = @(
    "run", "-n", $CondaEnv,
    "python", "-m", "uvicorn", "api.main:app",
    "--host", "0.0.0.0",
    "--port", "$Port"
)

$apiProcess = Start-Process -FilePath $condaExe -ArgumentList $apiArgs -PassThru -WindowStyle Hidden
Write-Host "API starting on http://127.0.0.1:$Port ..."

$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 4
        if ($r.StatusCode -eq 200) {
            $healthy = $true
            break
        }
    } catch {
        # keep waiting
    }
}

if (-not $healthy) {
    try { Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
    throw "API did not become healthy on port $Port"
}

Write-Host "API healthy. Opening public tunnel..."

$remoteSpec = if ([string]::IsNullOrWhiteSpace($Subdomain)) {
    "80:127.0.0.1:$Port"
} else {
    "$Subdomain`:80:127.0.0.1:$Port"
}

$sshArgs = @(
    "-o", "StrictHostKeyChecking=no",
    "-R", $remoteSpec,
    "nokey@localhost.run"
)

$publicUrl = $null

try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & ssh @sshArgs 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $line = $_.Exception.Message
            } else {
                $line = "$_"
            }

            if ([string]::IsNullOrWhiteSpace($line)) {
                return
            }

            Write-Host $line

            if (-not $publicUrl -and $line -match "https://[a-zA-Z0-9.-]+\.life") {
                $publicUrl = $matches[0]
                $urlFile = Join-Path $repoRoot "latest-public-url.txt"
                Set-Content -Path $urlFile -Value $publicUrl -Encoding ASCII
                Write-Host ""
                Write-Host "Public URL: $publicUrl" -ForegroundColor Green
                Write-Host "Health URL: $publicUrl/health" -ForegroundColor Green
                Write-Host "Saved to: $urlFile" -ForegroundColor Green
                Write-Host ""
            }
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}
finally {
    try {
        if ($apiProcess -and -not $apiProcess.HasExited) {
            Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
