---
name: vuln-hunter
description: "Vuln hunting 4-layer memory. CLI vulnmem.py."
---

# Vuln Hunter — 4-Layer Memory System

Source: ~/jarvis/vuln-hunter/

## Quick Start
```bash
cd ~/jarvis/vuln-hunter
python vulnmem.py recall --session target_<name> --query "<tech stack>"
python vulnmem.py add --session target_<name> --role user
python vulnmem.py classify --session target_<name>
python vulnmem.py fusion --session target_<name>
python vulnmem.py distill
python vulnmem.py status --session target_<name>
```

## 4-Layer Memory Model
| Layer | File | Purpose |
|-------|------|---------|
| L1 Instant | instant.py | Buffer raw observations, ~8000 chars, overflow keeps 60% |
| L2 Working | working.py | Baddeley 4-component: text loop (15 max), visuospatial, episodic buffer |
| L3 Short-term | shortterm.py | Vector semantic recall, 7-day expiry, Ebbinghaus decay |
| L4 Long-term | longterm.py | Hippocampal distillation → Entity-Relation-Entity graph (networkx+JSON) |

## CLI Commands
add, classify, commit-classify, fusion, commit-fusion, save-short, recall-short, distill, commit-kg, recall-long, recall, reinforce, expire-clean, status, save-state, load-state, sessions

## Workflow Rhythm
| Phase | Memory Action |
|-------|---------------|
| Start | recall → pull historical experience |
| Recon | add observations → classify → commit-classify |
| Analysis | fusion → commit-fusion → recall-short mid-way |
| Exploit | recall before PoC → save-short conclusions |
| Solidify | distill → commit-kg |
| Cleanup | expire-clean → status |

## Slash Commands
- /vuln-recall <keyword> — one-key historical recall
- /stop [note] — save progress, can resume later
- /sub — project completion distillation
- /study <file|url|topic> — learn article, distill into memory
- /report — generate structured report

## Tool Principles — Think → Trigger → Verify
| Tool | Trigger |
|------|---------|
| sqlmap | Confirmed injection point → deep exploit |
| nuclei | Framework+version identified → CVE scan |
| SSRFmap/Gopherus | Confirmed SSRF → protocol exploitation |
| XSStrike | Reflected point found → deep XSS |
| Arjun | Recon → hidden param discovery |
| dirsearch/ffuf | Recon → hidden paths |

## Vulnerability Rating
- HIGH: RCE, mass sensitive data, payment logic, SQLi→os-shell, admin takeover, auth bypass
- MEDIUM: General SQLi, stored XSS, IDOR write, SSRF→internal
- LOW: Limited exposure, info leak, rate limit missing, reflected XSS
- NOT COUNTED: Missing headers, weak TLS, version leaks, unverified CVE, compliance

## Key Files
- ~/jarvis/vuln-hunter/CLAUDE.md — project behavior spec
- ~/jarvis/vuln-hunter/vuln_memory/ — Python package
- ~/jarvis/vuln-hunter/漏洞等级标准.md — rating standard