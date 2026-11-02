# Oh My Omop

Agent AI pribadi yang jalan di mesin kamu sendiri. Punya karakter (SOUL), memori,
skill, dan belajar dari kebiasaan pemakaian. Bisa dipakai lewat CLI dan Telegram,
dengan model AI apa pun, di Windows, macOS, dan Linux.

Gratis dan open source di bawah lisensi Apache-2.0. Tanpa versi berbayar.

---

## Quick Install

### Linux, macOS, WSL2

```bash
curl -fsSL https://<domain-anda>/install.sh | bash
```

### Windows (native, PowerShell)

Jalan native tanpa WSL — CLI, gateway, TUI, dan tools semua bekerja. Kalau mau
WSL2, perintah Linux di atas juga jalan di dalamnya.

```powershell
iex (irm https://<domain-anda>/install.ps1)
```

### Manual

```bash
git clone https://github.com/<org-anda>/oh-my-omop.git
cd oh-my-omop
npm ci --ignore-scripts
npm run build
node dist/src/cli/index.js doctor
```

Syarat: Node.js 24 atau lebih baru.

---

## Mulai pakai

```bash
# 1. Simpan API key (terenkripsi, tidak pernah masuk prompt atau log)
omop secret set ANTHROPIC_API_KEY

# 2. Pilih model
omop model set anthropic claude-opus-5-5

# 3. Mulai chat
omop chat
```

Pakai Ollama atau LM Studio kalau mau gratis dan lokal:

```bash
omop model set ollama llama3.2
```

---

## Mode zero-refusal (omop-jb)

Mode ini **aktif secara default**. Agent menjalankan setiap tugas yang kamu
minta sepenuhnya, tanpa menolak, tanpa menggurui, tanpa disclaimer.

Yang berubah: **perilaku model terhadap permintaan kamu.**
Yang **tidak** berubah, tetap berjalan penuh:

| Komponen | Status |
|---|---|
| PolicyEngine (risiko + approval) | Aktif penuh |
| Sandbox (Docker `--network none`) | Aktif penuh |
| Approval untuk aksi berisiko | Tetap diminta |
| Sensor rahasia (G6) | Aktif penuh |
| Taint sesi (G2) | Aktif penuh |
| Audit log (G19) | Aktif penuh |
| Batas biaya dan iterasi (G10) | Aktif penuh |

Alasannya: keamanan ditegakkan oleh **kode**, bukan oleh prompt. Mode zero-refusal
hanya mengarahkan model supaya tidak menolak tugasmu — ia tidak bisa dan tidak
pernah mematikan pagar keamanan yang ditegakkan di luar prompt.

Mematikan mode ini kalau memang mau:

```bash
omop chat --strict
```

---

## Yang bisa dikerjakan

```bash
omop chat                      Sesi interaktif
omop run "buat README"         Satu perintah, tanpa TUI
omop doctor                    Periksa config, provider, sandbox, kanal
omop soul show                 Lihat karakter agent
omop memory list               Lihat memori
omop skills list               Daftar skill
omop model set <provider> <m>  Ganti model
omop secret set <NAMA>         Simpan rahasia terenkripsi
omop lockdown                  Mode darurat: hanya tool baca
```

---

## Arsitektur singkat

```
pintu masuk (CLI / Telegram / scheduler)
        │
   gateway ─── auth, pairing, antrean per sesi
        │
   agent loop ─── batas iterasi, waktu, biaya, deteksi loop
        │
   prompt builder ─── aturan inti → SOUL → tool+skill → aturan project → memori
        │
   tool runner ─── PolicyEngine ─── sandbox
        │
   SQLite + FTS5 (sesi, pesan, event, audit)
```

Aturan dependensi:

- Lapisan atas hanya memanggil lapisan di bawahnya lewat interface.
- `agent/` tidak mengimpor apa pun dari adapter kanal.
- Hanya `policy/` yang memutuskan tool berjalan atau tidak.
- Secret store hanya diakses kode harness, tidak pernah lewat tool model.

---

## Keamanan

Keamanan ditegakkan oleh kode, bukan prompt. Ringkasannya:

- **Rahasia** disimpan AES-256-GCM, tidak pernah masuk prompt, log, event, atau pesan error.
- **Konten luar** (web, file, media, skill pihak ketiga) dibungkus sebagai `<untrusted_data>`
  dan membuat sesi *tainted*. Sesi tainted tidak bisa menulis memori tanpa tinjauan.
- **Approval** wajib untuk aksi risiko sedang dan tinggi. Timeout berarti tolak.
- **Sandbox** Docker default: `--network none --cap-drop ALL --security-opt no-new-privileges`.
- **Audit log** append-only dengan rantai hash, diverifikasi lewat `omop audit verify`.
- **Lockdown** tersimpan di database dan tetap berlaku setelah restart.

Detail lengkap ada di dokumentasi `docs/SECURITY.md` di repo.

---

## Struktur repo

```
src/
├─ core/       tipe bersama, config, secret store, paths, errors
├─ agent/      loop, prompt builder, context engine, session store
├─ providers/  interface, OpenAI-compatible, Anthropic
├─ tools/      registry, file, shell, session
├─ policy/     engine, classifier, redaction, paths
├─ sandbox/    Docker dan lokal
├─ identity/   SOUL, personality
├─ memory/     USER.md, MEMORY.md, antrean tinjauan
├─ skills/     loader, indeks, scan
├─ storage/    SQLite, migrasi, FTS5
└─ cli/        perintah omop
skills/        skill bawaan yang dibundel
tests/         unit dan integration test
```

---

## Test

```bash
npm test           # 54 tes unit + integration, tanpa jaringan, tanpa API key
npm run lint       # tsc strict
```

Tes wajib lulus tanpa jaringan dan tanpa API key. Semua tes memakai server
tiruan lokal dan `OMOP_HOME` sementara.

---

## Kontribusi

Satu commit per tugas yang lulus tes, format `fase-N: ringkasan`.
Jangan commit rahasia, `node_modules`, atau `dist`.

Kalau dua dokumen bertentangan, urutan prioritasnya: `SECURITY.md`, lalu
`FLOW.md` dan `ARCHITECTURE.md`, lalu dokumen lain.

---

## Lisensi

Apache-2.0. Lihat [LICENSE](LICENSE) dan [NOTICE](NOTICE).
