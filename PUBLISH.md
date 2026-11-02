# Checklist sebelum publish

Repo ini siap publish. Sebelum push ke GitHub publik, selesaikan checklist ini.

## 1. Ganti placeholder

Cari dan ganti di file berikut:

| Placeholder | File | Ganti dengan |
|---|---|---|
| `<your-github-org>` | `install.sh`, `install.ps1`, `README.md` | Username atau org GitHub kamu |
| `<your-domain>` | `install.sh`, `install.ps1`, `README.md` | Domain tempat installer dihost |

Cara cepat:

```bash
grep -rn "your-github-org\|your-domain" --include="*.sh" --include="*.ps1" --include="*.md" .
```

## 2. Verifikasi tidak ada rahasia

```bash
./scripts/scrub-secrets.sh --check-only
```

Harus keluar `Bersih: tidak ada pola rahasia di repo.`

Script ini menolak kalau menemukan: pola `sk-`, `gh*_`, `AKIA`, token Telegram,
private key block, IP VPS produksi, path `/root/omop/`, dan domain produksi.

Direktori `tests/` dan `scripts/` dikecualikan dari scan karena sengaja memuat
pola tiruan untuk menguji redaction.

## 3. Jalankan tes

```bash
npm ci --ignore-scripts
npm test
npm run lint
```

Harus: `54 pass, 0 fail` dan `tsc` bersih.

## 4. Host installer

Upload `install.sh` dan `install.ps1` ke domain kamu supaya one-liner jalan:

```bash
curl -fsSL https://<domain-kamu>/install.sh | bash
```

```powershell
iex (irm https://<domain-kamu>/install.ps1)
```

Kalau belum ada domain, orang tetap bisa install manual:

```bash
git clone https://github.com/<org-kamu>/oh-my-omop.git
cd oh-my-omop
npm ci --ignore-scripts && npm run build
node dist/src/cli/index.js doctor
```

## 5. Push

```bash
git remote add origin https://github.com/<org-kamu>/oh-my-omop.git
git push -u origin master
```

## 6. Setelah publish

- Cek `install.sh` dan `install.ps1` bisa diunduh publik dari domain
- Jalankan installer di mesin bersih (VM) untuk verifikasi
- Pastikan `omop doctor` jalan setelah install

## Catatan mode zero-refusal

Repo ini publish dengan `config.mode: "jb"` (zero-refusal) sebagai default.

Yang berubah: perilaku model terhadap permintaan pemilik.
Yang tidak berubah, tetap penuh: PolicyEngine, sandbox, approval, sensor
rahasia, taint sesi, audit log, dan batas biaya.

Ini aman dipublish karena keamanan ditegakkan oleh kode, bukan prompt.
Orang yang install tetap punya pagar keamanan penuh.

Kalau kamu sendiri mau mematikannya:

```bash
omop chat --strict
```

## Yang belum ada di versi ini

Jujur apa adanya, supaya tidak salah ekspektasi:

- **Telegram gateway** — Fase 4, belum dibangun. CLI dulu.
- **Mesin kebiasaan** — Fase 5, belum dibangun.
- **Subagent** — Fase 6, belum dibangun.
- **Scheduler / cron** — Fase 6, belum dibangun.
- **TUI lengkap** — banner dan output CLI ada, TUI interaktif belum.

Yang sudah jalan dan teruji: fondasi, agent loop, policy engine, SOUL,
memori, skill, shell sandbox, CLI, installer.
