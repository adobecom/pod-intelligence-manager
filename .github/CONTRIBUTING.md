# Contributing to Pod Intelligence Manager

Thank you for taking the time to contribute.

## Before you start

- Check [open issues](https://github.com/adobecom/pod-intelligence-manager/issues) and
  [pull requests](https://github.com/adobecom/pod-intelligence-manager/pulls) to avoid duplicate work.
- For significant changes, open an issue first to discuss the approach.

## Development setup

```bash
# Prerequisites: Node 24+, pnpm 10.33.x
pnpm install
```

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start server (`:4000`) and UI (`:5173`) in watch mode |
| `pnpm typecheck` | TypeScript check across all packages |
| `pnpm test` | Run the full test suite |
| `pnpm build` | Production build |
| `pnpm docs:check` | Validate Markdown links and documented pnpm scripts |

## Submitting a pull request

1. Fork the repo and create a branch off `main`: `git checkout -b feat/your-feature`
2. Make your changes and ensure all checks pass locally.
3. Open a PR against `main`. Fill in the PR template.
4. A maintainer will review within a few business days.

**Branch naming conventions:**

| Prefix | Use for |
|--------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `chore/` | Tooling, deps, config |
| `refactor/` | Code restructuring without behavior change |

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sdk): add batchSubmit helper
fix(server): handle missing pod ID gracefully
docs: update architecture overview
```

## Code guidelines

- TypeScript everywhere — no `any` without a comment explaining why.
- No new `console.log` in production paths; use the existing logger.
- Keep PRs focused — one logical change per PR.
- Do not commit `.env` files, internal URLs, or Adobe-internal credentials.

## Reporting bugs

Open a [bug report issue](https://github.com/adobecom/pod-intelligence-manager/issues/new?template=bug_report.md) with steps to reproduce, expected vs. actual behavior, and your environment (OS, Node version).

## Proposing features

Open a [feature request issue](https://github.com/adobecom/pod-intelligence-manager/issues/new?template=feature_request.md) describing the problem you're solving and your proposed solution.

## License

By contributing you agree that your contributions will be licensed under the same license as this project.
