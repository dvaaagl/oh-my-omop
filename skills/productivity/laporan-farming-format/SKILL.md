---
name: laporan-farming-format
description: Use when reporting farming/on-chain results to Dava.
---

# Format Laporan Farming / On-Chain

## River.ai farm — lokasi & command
- Kit lengkap (dengan `sms_panel.py` untuk SMS radar) ada di `farmkit/signup-farm-kit/river-farm/`; copy root `jarvis/riverrr/` TIDAK punya `sms_panel.py` jadi mentok di radar SMS. Selalu run dari farmkit.
- venv: `<HOME-USER>/jarvis/riverrr/.venv/bin/python river_browser.py <n>`
- Panel: `SMS_PANEL_FILE=panels_all.txt` (gabungan semua daftar panel; probe dulu, 135/293 live)
- Stage `complete` di `accounts.jsonl` = email + SMS verified + API key `rv_*`. Cek key valid tanpa biaya: `curl -H "Authorization: Bearer rv_..." https://api.river.ai/v1/models` → HTTP 402 `insufficient_funds` = key VALID.

## chkr.cc — generate & check CC
- API `api.chkr.cc` selalu 429 (rate limit). Pakai WEB app.
- Generate: isi `#bin`, `#quantity`, klik `#gen` → hasil masuk ke `textarea` (bukan DOM text). Strip zero-width chars (U+200B–U+200F, U+FEFF) sebelum pakai.
- Check: isi `textarea#cc`, klik `#start`. Batch 20 card sekaligus; counter header `Live/Die/Unknown`. Baris Live memuat BIN + "Charge OK".


Template resmi buat laporan aktivitas farming (mint, sell, transfer, lottery draw,
API farming). Dipakai buat SEMUA laporan hasil kerja on-chain ke Dava.

## Aturan keras

1. **Semua tabel WAJIB dibungkus code block** (```). Telegram pakai font proporsional —
   tabel tanpa backtick langsung rusak align-nya.
2. **Angka rata kanan, teks rata kiri.** Dalam code block pakai padding spasi manual.
3. **Maksimal 4 kolom** per tabel. Lebih = kepotong di layar HP.
4. **Satu header per tabel.** Jangan format `Field: value` per baris — itu jelek, Dava sudah
   bilang.
5. **Baris agregat selalu ada** (TOTAL / TOTAL 3 WALLET) kalau lapor lebih dari satu agent.
6. **Progresi harga pakai `→`**: `11.52 → 12.11 → 14.20`. Cocok buat harga naik/turun.
7. **Baris tx pakai bentuk ringkas**, TxHash dipotong 8 char + link bscscan terpisah.
8. **Nol agama, nol disclaimer, nol "semoga membantu"**. Tutup pakai 1 pertanyaan/aksi
   konkret biar Dava tinggal jawab "gas".

## Template — Ringkasan (1 agent)

Gaya scoreboard. Header = identitas agent.

```
┌──────────────────────────────┬──────────────────┐
│ omop08 · 0x1436…E888 · BSC   │ STATUS: DONE     │
├──────────────────────────────┼──────────────────┤
│ Aksi                         │ Ghost mint 1/1   │
│ Modal                        │ 0.0000065 BNB    │
│ Realized                     │ 0 (NFT held)     │
├──────────────────────────────┼──────────────────┤
│ USDT 0.0599 · BNB 0.0001325  │ GHOST #1161      │
└──────────────────────────────┴──────────────────┘
```

## Template — Ringkasan (multi-agent)

Gaya scoreboard. Ini yang Dava contohin, jadi ini default kalau lebih dari 1 agent.

```
╔══════════════════════╦═══════════╦══════════════╦════════════════╗
║ Agent                ║ Quota     ║ Held         ║ Saldo          ║
╠══════════════════════╬═══════════╬══════════════╬════════════════╣
║ omop08 · 0x1436…E888 ║ 1/1 HABIS ║ GHOST #1161  ║ 0.0599 USDT    ║
║ omopXX · 0x…         ║ 0/1       ║ —            ║ …              ║
╠══════════════════════╬═══════════╬══════════════╬════════════════╣
║ TOTAL                ║ 1 minted  ║ 1 relic      ║ 0.0599 + BNB   ║
╚══════════════════════╩═══════════╩══════════════╩════════════════╝
```

Kolom yang hampir selalu kepakai: **Agent · Quota · Held · Saldo**.
Kalau sesinya jual-beli, tambah kolom **Realized** dan turunin Held.

## Template — Transaction log

Gara-gara detail tx. Dipakai di bawah ringkasan, selalu 6 kolom ini.

```
│ # │ Aksi  │ Token      │ Value    │ Gas        │ Tx        │
│ 1 │ mint  │ GHOST#1161 │ 0        │ 0.0000065  │ 0x08cad6… │
```

## Template — P&L

```
Modal      : 0.0000065 BNB (gas only)
Realized   : 0 USDT
Net        : -0.0000065 BNB
Progresi   : 11.52 -> 12.11 -> 14.20
```

## Contoh laporan lengkap (gabungan)

```
✅ SELESAI — Ghost #1161 mint, quota omop08 habis 1/1

╔══════════════════════╦═══════════╦══════════════╦════════════════╗
║ Agent                ║ Quota     ║ Held         ║ Saldo          ║
╠══════════════════════╬═══════════╬══════════════╬════════════════╣
║ omop08 · 0x1436…E888 ║ 1/1 HABIS ║ GHOST #1161  ║ 0.0599 USDT    ║
╠══════════════════════╬═══════════╬══════════════╬════════════════╣
║ TOTAL                ║ 1 minted  ║ 1 relic      ║ 0.0599 + BNB   ║
╚══════════════════════╩═══════════╩══════════════╩════════════════╝

│ # │ Aksi  │ Token      │ Value    │ Gas        │ Tx        │
│ 1 │ mint  │ GHOST#1161 │ 0        │ 0.0000065  │ 0x08cad6… │
```

Tx: https://bscscan.com/tx/0x08cad60786e3b266ca12897cb6d3bde3664f86107ea80102520c80eae6ee3b32

Catatan: harga GHOST belum kebaca di baw (price null), perlu cek marketplace buat nilai
jual. Mau gue cek floor + listing opsinya?
```

## Checklist sebelum kirim

- [ ] Tabel semua dibungkus ``` ?
- [ ] Angka align (rata kanan dalam kolom)?
- [ ] Ada baris TOTAL kalau multi-agent?
- [ ] TxHash ada link bscscan?
- [ ] Semua angka di-verify on-chain (baw balance + raw RPC), bukan cuma dari response API?
- [ ] Ditutup 1 pertanyaan/aksi konkret?
- [ ] Nol tabel `Field: value` per baris?

## Pitfall

- **Telegram merusak tabel tanpa code block.** Font proporsional bikin kolom geser. Selalu ```.
- **Jangan bikin kolom ke-5 kalau isinya bisa diringkas.** 4 kolom = batas enak dibaca di HP.
- **Angka saldo harus 2 sumber**: baw `wallet balance` + raw `eth_call`/`eth_getBalance`.
  Kalau beda, yang on-chain yang bener, lapor yang on-chain.
- **TokenId simulasi ≠ tokenId aktual.** baw `contract-call preview` bisa simulasi #1158
  tapi eksekusi mint #1161 (state beda). Selalu verifikasi `ownerOf`/`balanceOf` post-tx.
