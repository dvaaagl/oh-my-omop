---
name: hunter-skills
description: "37 offensive modules. Load per vuln class for payloads."
---

# Hunter Skills — Offensive Security Module Library

Source: ~/jarvis/hunter-skills/Skills/

37 modular offensive security skills. Each standalone SKILL.md with methodology, payloads, tools, remediation.

## Skill Map

### Web App Vulns
| Dir | Lines | Summary |
|-----|-------|---------|
| offensive-sqli | ~859 | Error/Blind/UNION/OOB/Second-order/NoSQL; WAF bypass; DB cheatsheets |
| offensive-xss | ~782 | Reflected/Stored/DOM/Blind XSS; polyglot; CSP bypass |
| offensive-ssrf | ~828 | Discovery/blind; cloud metadata; DNS rebinding; SSRF→RCE |
| offensive-xxe | ~994 | Classic/blind XXE; upload vectors; XXE→SSRF |
| offensive-ssti | ~347 | Template engine ID; Jinja2/Twig/Freemarker chains |
| offensive-rce | ~1067 | Cmd injection, SSTI→RCE, deser, upload, dependency confusion |
| offensive-idor | ~606 | Horizontal/vertical escalation; object ID enum |
| offensive-file-upload | ~820 | MIME/ext/magic bypass; path traversal; webshell |
| offensive-open-redirect | ~485 | Encoding/double-slash/CRLF; chain to OAuth/SSRF |
| offensive-race-condition | ~879 | TOCTOU; Turbo Intruder; Last-Byte sync; double-spend |
| offensive-request-smuggling | ~771 | CL.TE/TE.CL/TE.TE; HTTP/2 smuggling; cache poisoning |
| offensive-parameter-pollution | ~593 | HPP; parsing diff; WAF bypass |
| offensive-graphql | ~207 | Introspection, batching, depth DoS, authz bypass |
| offensive-jwt | ~396 | none/alg confusion, weak key, kid/jku/x5u injection |
| offensive-oauth | ~364 | Auth code interception, redirect_uri bypass, state abuse |
| offensive-deserialization | ~183 | Java/PHP/.NET/Python; ysoserial; magic methods |
| offensive-waf-bypass | ~818 | Multi-encoding, comment injection, chunked, protocol bypass |

### Recon & Intel
| Dir | Lines | Summary |
|-----|-------|---------|
| offensive-osint | ~482 | Domain/email/social/GitHub/Shodan/Censys/leaks |
| offensive-osint-methodology | ~432 | Target definition, source selection, collection |
| offensive-fast-checking | ~485 | Quick assessment, speed-win mode |
| offensive-bug-identification | ~1254 | Code audit, taint analysis, dangerous funcs |
| offensive-initial-access | ~1526 | Phishing, credential stuffing, supply chain |

### Exploit Dev
| Dir | Lines | Summary |
|-----|-------|---------|
| offensive-vuln-classes | ~1227 | Stack/heap overflow, UAF, integer, format string |
| offensive-fuzzing-course | ~2103 | AFL++/libFuzzer curriculum |
| offensive-fuzzing | ~1744 | Fuzzing methodology and tool selection |
| offensive-crash-analysis | ~12464 | WinDbg/GDB, ASAN, exploitability |
| offensive-basic-exploitation | ~10781 | EIP/RIP, ROP, ret2libc, shellcode, ASLR/NX bypass |
| offensive-windows-boundaries | ~15151 | Windows security boundaries and attack surface |
| offensive-windows-mitigations | ~14544 | ASLR/DEP/CFG/CET/Heap Guard bypass |
| offensive-exploit-dev-course | ~426 | Full exploit dev curriculum roadmap |
| offensive-exploit-development | ~697 | Environment, debug, PoC lifecycle, pwntools |
| offensive-shellcode | ~656 | x86/x64 shellcode, null-free, encoders, PIC |
| offensive-mitigations | ~1349 | Universal mitigations and bypass directory |

### Red Team
| Dir | Lines | Summary |
|-----|-------|---------|
| offensive-advanced-redteam | ~146 | OPSEC, C2, LOTL, lateral, persistence, exfil |
| offensive-edr-evasion | ~1804 | Unhook, direct syscall, PPID spoof, AMSI/ETW |
| offensive-keylogger-arch | ~195 | Keyboard logging: hooks, ETW, driver-level |

### AI / Emerging
| Dir | Lines | Summary |
|-----|-------|---------|
| offensive-ai-security | ~590 | Prompt injection, jailbreak, model extraction, RAG poisoning |

## Usage
Read ~/jarvis/hunter-skills/Skills/offensive-{topic}/SKILL.md

Total: 37 skills, ~79,000 lines.

## Integration
- pentest-lyan manages flow → hunter-skills provides methodology per vuln class
- vuln-hunter stores experience → hunter-skills provides technique specifics