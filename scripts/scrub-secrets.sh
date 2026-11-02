#!/usr/bin/env bash
# Scrub kredensial dari seluruh repo sebelum publish publik.
# Mengganti nilai rahasia dengan placeholder dan MEMBATALKAN commit
# kalau masih menemukan pola berisiko.
#
# Pakai:  ./scripts/scrub-secrets.sh [--check-only]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECK_ONLY=0
if [[ "${1:-}" == "--check-only" ]]; then
  CHECK_ONLY=1
fi

# Pola yang harus selalu ditolak di repo publik.
PATTERNS=(
  'sk-[A-Za-z0-9_-]{20,}'
  'gh[pousr]_[A-Za-z0-9]{16,}'
  'AKIA[0-9A-Z]{16}'
  '[0-9]{8,10}:[A-Za-z0-9_-]{35,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '182\.253\.124\.153'
  'omop\.service'
  '<OMOP_HOME>/'
  'omop_router\.db'
  'omoapicall\.web\.id'
)

# Direktori dan file yang tidak ikut dipindai.
# - tests/ memakai pola tiruan dengan format sama seperti rahasia asli
#   (wajar, itu memang tujuannya: menguji redaction).
# - scripts/scrub-secrets.sh memuat daftar polanya sendiri.
EXCLUDE_DIRS=(node_modules dist .git tests scripts)

echo "Memindai repo untuk pola rahasia..."
found=0
for pat in "${PATTERNS[@]}"; do
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    echo "  DITEMUKAN: $line"
    found=$((found + 1))
  done < <(grep -rEl "$pat" \
      --exclude-dir=node_modules \
      --exclude-dir=dist \
      --exclude-dir=.git \
      --exclude-dir=tests \
      --exclude-dir=scripts \
      . 2>/dev/null || true)
done

if [[ $found -gt 0 ]]; then
  echo ""
  echo "GAGAL: $found file memuat pola rahasia/data produksi."
  echo "Scrub dulu sebelum publish. Edit file, ganti nilai dengan placeholder."
  exit 1
fi

echo "Bersih: tidak ada pola rahasia di repo."

if [[ $CHECK_ONLY -eq 1 ]]; then
  exit 0
fi

echo ""
echo "Mengganti domain/IP/spesifik-instalasi dengan placeholder..."
find . -type f \( -name '*.md' -o -name '*.ts' -o -name '*.sh' -o -name '*.yaml' -o -name '*.yml' -o -name '*.json' \) \
  -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*' \
  -exec sed -i \
    -e 's|182\.253\.124\.153|<IP-VPS>|g' \
    -e 's|omoapicall\.web\.id|<domain-produksi>|g' \
    -e 's|<OMOP_HOME>|<OMOP_HOME>|g' \
    -e 's|/root/\.secrets|<DIR-RAHASIA>|g' \
    -e 's|<HOME-USER>|<HOME-USER>|g' \
    {} +

echo "Selesai. Jalankan lagi dengan --check-only untuk verifikasi."
