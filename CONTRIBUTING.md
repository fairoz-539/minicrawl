# Contributing to minicrawl

Thanks for helping! Bug reports, docs fixes, tests and features are all welcome.

## Ways to contribute

- **Report a bug:** open an [issue](../../issues/new/choose) with the URL (if public), the request body, and what you expected vs. got. `GET /health` output and `docker compose logs minicrawl` help a lot.
- **Suggest a feature:** open a feature request and describe the use case first. For larger changes, please discuss before writing code.
- **Improve docs:** typos, unclear steps and missing examples are great first PRs.
- **Fix or build something:** issues labelled `good first issue` and `help wanted` are good starting points.

Security problems: please **don't** open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 22.13+ (24 recommended) and git. Docker is optional.

```bash
git clone https://github.com/fairoz-539/minicrawl.git
cd minicrawl
npm install
npx playwright install chromium     # once; on Linux: npx playwright install --with-deps chromium
npm start                           # http://localhost:3002, reads .env if present
```

No API key is needed for local `npm start`. Only the Docker image requires one.

## Tests

```bash
npm test
```

The suite is end-to-end and runs offline. It starts the API against:
- a local fixture website (`test/fixture-site.js`), including generated PDFs, Office files and images (`test/fixture-files.js`)
- a mock Anthropic API and a mock forward proxy (`test/mock-services.js`)

It doesn't call real Claude, SearXNG or external sites.

- Add or update a test for every behaviour change, and prefer end-to-end tests through the HTTP API.
- New request fields belong in `src/schemas.js`. The OpenAPI spec is generated from it, and a test fails if a route is missing from the spec.
- Keep the suite fast and deterministic: serve what you need from the fixture site instead of hitting the internet.

To check the Docker image too:

```bash
bash scripts/setup.sh && docker compose up -d --build
curl http://localhost:3002/health
```

## Code style

- Plain modern JavaScript (ES modules, Node 22+). No build step and no TypeScript.
- Match the surrounding code: small focused modules, comments that explain *why*, descriptive names.
- Validate input with zod in `src/schemas.js`. Return errors with a stable `code` (see `docs/API.md#errors`).
- Don't log or return secrets (API keys, proxy credentials).
- Keep dependencies minimal and well-maintained. Explain any new one in the PR.

## Pull requests

1. Fork and create a branch: `git checkout -b fix/short-description`.
2. Make the change, with tests and docs (`README.md`, `docs/`, `.env.example` for new settings).
3. Run `npm test`.
4. Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/) style: `feat: …`, `fix: …`, `docs: …`, `test: …`, `chore: …`.
5. Open the PR and fill in the template. CI must pass.

By contributing, you agree that your contributions are licensed under the project's [AGPL-3.0 license](LICENSE).

## Responsible scraping

minicrawl must stay a good citizen of the web. We don't accept contributions that solve CAPTCHAs, spoof browser fingerprints to evade bot protection, ignore robots.txt by default, or otherwise help bypass a site's access controls.
