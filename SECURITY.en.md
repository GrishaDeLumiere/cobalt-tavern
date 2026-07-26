<div align="right">
 <a href="SECURITY.md">🇷🇺 Русский</a> | <strong>🇬🇧 English</strong>
</div>

# 🛡️ SECURITY POLICY

**Cobalt Tavern** is an ultimate UI built for **STRICTLY LOCAL** usage. The core engine does not collect telemetry, ping external servers, or leak your data. Your prompts, lorebooks, and chat logs remain securely on your hard drive.

⚠️ **WARNING:** If you choose to bind the server to `0.0.0.0` and expose the interface to the public internet, **you do so at your own risk**. This project is not intended to be used as a public web service, and the author holds no liability for compromised hosting environments.

## 🟢 Supported Versions

Due to the rapid development cycle, official patches and security fixes are only provided for the latest version.

| Branch / Release | Status |
| :--- | :--- |
| `main` (Latest commit) | ✅ Supported |
| Older commits | ❌ Unsupported |
| Unofficial Forks | 🚫 **ILLEGAL & UNSUPPORTED** |

## 🎯 Threat Model (What we fix)

Given the local nature of the software, traditional web vulnerabilities (like DDoS) are irrelevant unless you attack yourself. We focus on vulnerabilities that could harm your PC when importing third-party data:

**IN scope (Will be patched):**
- **Path Traversal:** The ability for a script/request to escape the `data/` directory and access OS files.
- **RCE (Remote Code Execution):** Malicious code execution triggered by importing third-party Character Cards (`.png`/`.json`) or chat logs (`.jsonl`).
- **Critical Core Crashes:** Logic bugs causing fatal backend (Fastify) failures when parsing specific syntax.

**OUT of scope (Not our problem):**
- Attacks requiring physical access to your PC.
- Vulnerabilities within third-party LLM inference servers (KoboldCpp, LM Studio, etc.).
- Compromises resulting from hosting the project on the public internet without a VPN/Tunnel.

## 🚨 Reporting a Vulnerability

If you discover a critical security flaw in the core:
1. Open a new [Issue](https://github.com/GrishaDeLumiere/Cobalt-Tavern/issues) in this repository.
2. Prefix your issue title with **`[SECURITY]`** (e.g., `[SECURITY] Path Traversal on background upload`).
3. Provide clear steps or logs to reproduce the issue.

We will investigate and deploy a patch as soon as possible.