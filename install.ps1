# Oh My Omop — quick install untuk Windows native (PowerShell).
#
#   iex (irm https://<domain-anda>/install.ps1)
#
# Berjalan native tanpa WSL: CLI, gateway, TUI, dan tools semua jalan.
# Kalau mau WSL2, pakai install.sh Linux/macOS di dalam WSL2.
#
# Tidak ada rahasia yang dikumpulkan skrip ini. API key diminta kemudian
# lewat `omop secret set`.

$ErrorActionPreference = "Stop"

$OmopVersion = if ($env:OMOP_VERSION) { $env:OMOP_VERSION } else { "latest" }
$OmopRepo = if ($env:OMOP_REPO) { $env:OMOP_REPO } else { "https://github.com/<org-anda>/oh-my-omop.git" }
$InstallDir = if ($env:OMOP_INSTALL_DIR) { $env:OMOP_INSTALL_DIR } else { "$env:USERPROFILE\.oh-my-omop" }
$BinDir = if ($env:OMOP_BIN_DIR) { $env:OMOP_BIN_DIR } else { "$env:USERPROFILE\.local\bin" }
$NodeMajor = 24

function Say($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "peringatan: $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# ── 1. Platform ──────────────────────────────────────────────────
Say "Platform: Windows $env:PROCESSOR_ARCHITECTURE"

# ── 2. Node.js ───────────────────────────────────────────────────
function Test-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $ver = (node -p "process.versions.node.split('.')[0]" 2>$null)
    if (-not $ver) { return $false }
    return ([int]$ver -ge $NodeMajor)
}

if (Test-Node) {
    Say "Node.js $(node --version) sudah pas."
}
else {
    Say "Node.js $NodeMajor+ belum ada. Memasang..."

    $installed = $false

    # winget
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Say "Memakai winget..."
        try {
            winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Node) { $installed = $true }
        }
        catch { Warn "winget gagal: $_" }
    }

    # Chocolatey
    if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) {
        Say "Memakai Chocolatey..."
        try {
            choco install nodejs-lts -y --no-progress
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Node) { $installed = $true }
        }
        catch { Warn "choco gagal: $_" }
    }

    # Scoop
    if (-not $installed -and (Get-Command scoop -ErrorAction SilentlyContinue)) {
        Say "Memakai Scoop..."
        try {
            scoop install nodejs-lts
            if (Test-Node) { $installed = $true }
        }
        catch { Warn "scoop gagal: $_" }
    }

    if (-not $installed) {
        Die "Tidak bisa memasang Node.js otomatis. Unduh dari https://nodejs.org (v$NodeMajor+ LTS), pasang, lalu buka PowerShell baru dan jalankan lagi."
    }
    Say "Node.js $(node --version) terpasang."
}

# ── 3. npm ───────────────────────────────────────────────────────
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "npm tidak ditemukan setelah instalasi Node.js. Buka PowerShell baru."
}

# ── 4. Ambil kode ────────────────────────────────────────────────
if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path "$InstallDir\.git")) {
    Say "Memperbarui instalasi yang ada di $InstallDir"
    git -C $InstallDir fetch --depth 1 origin
    if ($OmopVersion -eq "latest") {
        git -C $InstallDir reset --hard origin/HEAD
    }
    else {
        git -C $InstallDir checkout $OmopVersion
    }
}
elseif (Get-Command git -ErrorAction SilentlyContinue) {
    Say "Mengunduh oh-my-omop ke $InstallDir"
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    git clone --depth 1 $OmopRepo $InstallDir
}
else {
    # Tanpa git: unduh tarball rilis.
    Say "git tidak ditemukan. Mengunduh arsip rilis..."
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    $tarball = "$env:TEMP\oh-my-omop.tar.gz"
    $url = if ($OmopVersion -eq "latest") {
        "$OmopRepo/archive/refs/heads/main.tar.gz"
    } else {
        "$OmopRepo/archive/refs/tags/$OmopVersion.tar.gz"
    }
    Invoke-WebRequest -Uri $url -OutFile $tarball -UseBasicParsing
    tar -xzf $tarball -C $env:TEMP
    $extracted = Get-ChildItem -Directory "$env:TEMP" -Filter "oh-my-omop-*" |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $extracted) { Die "Arsip rilis tidak bisa diekstrak." }
    Copy-Item -Path "$($extracted.FullName)\*" -Destination $InstallDir -Recurse -Force
    Remove-Item $tarball -Force
}

Set-Location $InstallDir

# ── 5. Dependensi (rantai pasok: tanpa script paket) ─────────────
Say "Memasang dependensi (npm ci --ignore-scripts)"
npm ci --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die "npm ci gagal." }

# ── 6. Build ─────────────────────────────────────────────────────
Say "Build TypeScript"
npm run build
if ($LASTEXITCODE -ne 0) { Die "build gagal." }

# ── 7. Tautkan binary ────────────────────────────────────────────
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
$wrapper = @"
@echo off
node "$InstallDir\dist\src\cli\index.js" %*
"@
$cmdPath = Join-Path $BinDir "omop.cmd"
Set-Content -Path $cmdPath -Value $wrapper -Encoding ascii
Say "Binary omop dipasang di $cmdPath"

# Tambahkan ke PATH pengguna kalau belum ada.
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    [System.Environment]::SetEnvironmentVariable(
        "Path",
        "$userPath;$BinDir",
        "User"
    )
    Say "PATH pengguna diperbarui. Buka PowerShell baru supaya berlaku."
    $env:Path = "$env:Path;$BinDir"
}

# ── 8. Doctor ────────────────────────────────────────────────────
Say "Menjalankan omop doctor"
& "$BinDir\omop.cmd" doctor
if ($LASTEXITCODE -ne 0) { Warn "Ada pemeriksaan yang perlu perhatian." }

Write-Host ""
Write-Host "Selesai. Langkah berikutnya:" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Set API key model (contoh Anthropic):"
Write-Host "       omop secret set ANTHROPIC_API_KEY"
Write-Host ""
Write-Host "  2. Pilih model:"
Write-Host "       omop model set anthropic claude-opus-5-5"
Write-Host ""
Write-Host "  3. Mulai chat:"
Write-Host "       omop chat"
Write-Host ""
Write-Host "  Mode zero-refusal (omop-jb) aktif secara default. PolicyEngine, sandbox,"
Write-Host "  approval, dan sensor rahasia tetap berjalan penuh. Untuk mematikannya:"
Write-Host "       omop chat --strict"
Write-Host ""
Write-Host "  Bantuan: omop help"
