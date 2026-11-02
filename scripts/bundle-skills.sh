#!/usr/bin/env bash
# Bundel skill dari instalasi Hermes lokal ke repo oh-my-omop/skills/.
# Skill pihak ketiga diperlakukan sebagai kode tidak tepercaya: semua
# konten dipindai dan DISENSOR dari kredensial sebelum masuk repo publik.
#
# Pakai:  ./scripts/bundle-skills.sh [sumber-skills-dir]
set -euo pipefail

SRC="${1:-$HOME/.hermes/skills}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/skills"

# Skill yang dibundel: nama sumber -> kategori/nama tujuan
BUNDLE=(
  "security/hunter-skills:security/hunter-skills"
  "security/pentest-lyan:security/pentest-lyan"
  "security/vuln-hunter:security/vuln-hunter"
  "security/ikona-osint-arsenal:security/ikona-osint-arsenal"
  "security/osint-full-spectrum:security/osint-full-spectrum"
  "security/person-osint:security/person-osint"
  "security/source-driven-exploitation:security/source-driven-exploitation"
  "security/web-exploit-test:security/web-exploit-test"
  "hermes/godmode:security/godmode"
  "hermes/devil-jarvis:security/devil-jarvis"
  "hermes/model-sentinel:security/model-sentinel"
  "hermes/llm-guardrail-disarm:security/llm-guardrail-disarm"
  "automation/laporan-farming-format:productivity/laporan-farming-format"
  "devops/9router:devops/9router"
  "software-development/subagent-driven-development:development/subagent-driven-development"
  "software-development/systematic-debugging:development/systematic-debugging"
  "software-development/test-driven-development:development/test-driven-development"
)

mkdir -p "$DEST"

bundled=0
skipped=0
for entry in "${BUNDLE[@]}"; do
  src_rel="${entry%%:*}"
  dest_rel="${entry##*:}"
  src_dir="$SRC/$src_rel"
  dest_dir="$DEST/$dest_rel"

  if [[ ! -d "$src_dir" ]]; then
    echo "  lewat (tidak ada): $src_rel"
    skipped=$((skipped + 1))
    continue
  fi

  mkdir -p "$dest_dir"
  # Salin SKILL.md dan file pendukung.
  if [[ -f "$src_dir/SKILL.md" ]]; then
    cp "$src_dir/SKILL.md" "$dest_dir/SKILL.md"
  fi
  for sub in references templates scripts assets; do
    if [[ -d "$src_dir/$sub" ]]; then
      mkdir -p "$dest_dir/$sub"
      cp -r "$src_dir/$sub/." "$dest_dir/$sub/"
    fi
  done
  echo "  ok: $dest_rel"
  bundled=$((bundled + 1))
done

echo ""
echo "Bundel selesai: $bundled skill disalin, $skipped dilewat."
echo ""
echo "PENTING: jalankan scrub sebelum commit publik:"
echo "  ./scripts/scrub-secrets.sh"
