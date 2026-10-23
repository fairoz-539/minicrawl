# Security policy

## Supported versions

Security fixes go into the latest release on the `main` branch. Please update before reporting.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Include:

- what the issue is and its impact
- steps to reproduce (a minimal request is ideal)
- the version (`GET /health` → `version`) and how you run it (Docker or Node)

You can expect an acknowledgement within a few days. Once a fix is ready, we'll publish an advisory and credit you if you wish.

## Scope

These are especially relevant to minicrawl:

- authentication bypass on `/v1/*`
- SSRF: reaching private or local addresses while `ALLOW_PRIVATE_URLS=false`
- leaking secrets (API keys, proxy credentials, `ANTHROPIC_API_KEY`) through responses, logs or `/health`
- code execution or file access on the server through crafted pages or files

## Hardening checklist for operators

- Use a long random `API_KEY`, one per client (`API_KEYS`). The setup script generates them.
- Keep `ALLOW_PRIVATE_URLS=false` on shared servers.
- Put HTTPS in front when exposing to the internet (see [SELF_HOSTING.md](docs/SELF_HOSTING.md#exposing-it-on-the-internet-https)).
- Never commit or share `.env`.
- Keep the image updated: `git pull && docker compose up -d --build`.
