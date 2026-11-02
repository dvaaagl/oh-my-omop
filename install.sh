#!/usr/bin/env bash
# Oh My Omop — quick install untuk Linux, macOS, dan WSL2.
#
#   curl -fsSL https://<domain-anda>/install.sh | bash
#
# Skrip ini:
#   1. Cek Node.js 24+ (pasang kalau belum ada, via nvm atau package manager)
#   2. Clone atau unduh repo oh-my-omop
#   3. npm ci --ignore-scripts (rantai pasok: tanpa script paket)
#   4. Build TypeScript
#   5. Tautkan binary `omop` ke PATH
#   6. Jalankan omop doctor
#
# Tidak ada rahasia yang dikumpulkan skrip ini. API key diminta kemudian
# lewat `omop secret set`.

set -euo pipefail

OMOP_VERSION="${OMOP_VERSION:-latest}"
OMOP_REPO="${OMOP_REPO:-https://github.com/<org-anda>/oh-my-omop.git}"
OMOP_INSTALL_DIR="${OMOP_INSTALL_DIR:-$HOME/.oh-my-omop}"
OMOP_BIN_DIR="${OMOP_BIN_DIR:-$HOME/.local/bin}"
NODE_MAJOR=24

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mperingatan:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Deteksi platform ──────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  *) die "Platform $OS belum didukung. Pakai WSL2 di Windows." ;;
esac
say "Platform: $OS $(uname -m)"

# ── 2. Node.js ───────────────────────────────────────────────────
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" -ge "$NODE_MAJOR" ]]
}

if node_ok; then
  say "Node.js $(node --version) sudah pas."
else
  say "Node.js $NODE_MAJOR+ belum ada. Memasang..."
  if command -v nvm >/dev/null 2>&1 || [[ -d "$HOME/.nvm" ]]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
    nvm install "$NODE_MAJOR" && nvm alias default "$NODE_MAJOR"
  elif [[ "$OS" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    brew install "node@$NODE_MAJOR"
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "nodejs:$NODE_MAJOR"
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm nodejs-lts-jod npm
  else
    die "Tidak bisa memasang Node.js otomatis. Pasang Node.js $NODE_MAJOR+ manual lalu jalankan lagi."
  fi
  node_ok || die "Node.js masih belum $NODE_MAJOR+ setelah instalasi."
fi

# ── 3. npm ───────────────────────────────────────────────────────
command -v npm >/dev/null 2>&1 || die "npm tidak ditemukan."

# ── 4. Ambil kode ────────────────────────────────────────────────
if [[ -d "$OMOP_INSTALL_DIR/.git" ]]; then
  say "Memperbarui instalasi yang ada di $OMOP_INSTALL_DIR"
  git -C "$OMOP_INSTALL_DIR" fetch --depth 1 origin
  if [[ "$OMOP_VERSION" == "latest" ]]; then
    git -C "$OMOP_INSTALL_DIR" reset --hard origin/HEAD
  else
    git -C "$OMOP_INSTALL_DIR" checkout "$OMOP_VERSION"
  fi
else
  say "Mengunduh oh-my-omop ke $OMOP_INSTALL_DIR"
  rm -rf "$OMOP_INSTALL_DIR"
  git clone --depth 1 "$OMOP_REPO" "$OMOP_INSTALL_DIR"
fi

cd "$OMOP_INSTALL_DIR"

# ── 5. Dependensi (rantai pasok: tanpa script paket) ─────────────
say "Memasang dependensi (npm ci --ignore-scripts)"
npm ci --ignore-scripts --no-audit --no-fund

# ── 6. Build ─────────────────────────────────────────────────────
say "Build TypeScript"
npm run build

# ── 7. Tautkan binary ────────────────────────────────────────────
mkdir -p "$OMOP_BIN_DIR"
cat > "$OMOP_BIN_DIR/omop" <<EOF
#!/usr/bin/env bash
exec node "$OMOP_INSTALL_DIR/dist/src/cli/index.js" "\$@"
EOF
chmod +x "$OMOP_BIN_DIR/omop"
say "Binary omop dipasang di $OMOP_BIN_DIR/omop"

case ":$PATH:" in
  *":$OMOP_BIN_DIR:"*) ;;
  *)
    warn "$OMOP_BIN_DIR belum ada di PATH."
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [[ -f "$rc" ]] && ! grep -q "$OMOP_BIN_DIR" "$rc"; then
        echo "export PATH=\"$OMOP_BIN_DIR:\$PATH\"" >> "$rc"
        say "PATH ditambahkan ke $rc (muat ulang shell atau jalankan: source $rc)"
      fi
    done
    ;;
esac

# ── 8. Doctor ────────────────────────────────────────────────────
say "Menjalankan omop doctor"
"$OMOP_BIN_DIR/omop" doctor || warn "Ada pemeriksaan yang perlu perhatian. Lihat output di atas."

cat <<'DONE'

Selesai. Langkah berikutnya:

  1. Set API key model (contoh Anthropic):
       omop secret set ANTHROPIC_API_KEY

  2. Pilih model:
       omop model set anthropic claude-opus-5-5

  3. Mulai chat:
       omop chat

  Mode zero-refusal (omop-jb) aktif secara default. PolicyEngine, sandbox,
  approval, dan sensor rahasia tetap berjalan penuh. Untuk mematikannya:
       omop chat --strict

  Bantuan: omop help
DONE
