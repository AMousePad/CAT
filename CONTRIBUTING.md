# Contributing to CAT

CAT is a [Lumiverse](https://github.com/Prolix-OC/Lumiverse) extension that generates parallel swipes using different presets and connections.

Thank you for considering a contribution. Please read this document before opening a pull request; PRs that clearly ignore this will be closed.

## Table of contents

- [Contributing to CAT](#contributing-to-cat)
  - [Table of contents](#table-of-contents)
  - [Setting up the dev environment](#setting-up-the-dev-environment)
  - [Build](#build)
  - [Tests](#tests)
  - [Deploying to a Lumiverse instance](#deploying-to-a-lumiverse-instance)
  - [Pull request guidelines](#pull-request-guidelines)
  - [Performance changes](#performance-changes)
  - [Use of AI coding tools](#use-of-ai-coding-tools)
  - [Code conventions](#code-conventions)
  - [Repo layout](#repo-layout)
  - [Legal](#legal)

## Setting up the dev environment

Requirements:

- [Bun](https://bun.sh) 1.4.4 or newer — build, tests, and tooling all run on Bun.
- Required: a [Lumiverse](https://github.com/Prolix-OC/Lumiverse) staging checkout, to deploy and live-test the extension.

```bash
git clone <your fork>
cd CAT
bun install
```

## Build

```bash
bun run build
```

This typechecks and bundles `src/backend.ts` / `src/frontend.ts` into `dist/`. Run the build after source changes and include the rebuilt `dist/` in the same commit. Deployment uses the local built bundles.

## Tests

```bash
bun run test                    # must pass before every PR
bun run test:host ../Lumiverse   # isolated host checks
```

Tests live under `tests/`, organized by source area.

**Every change needs a test.** If the change is a bug fix, the test must fail without the fix and pass with it. State this in the PR description and make it easy to verify (e.g. name the test and the commit where it starts passing).

## Deploying to a Lumiverse instance

```bash
bun run deploy
```

The PowerShell script uses the `-Dest` parameter or `../Lumiverse/data/extensions/another_one/repo`. Restart the extension and hard-refresh the browser tab.

## Pull request guidelines

- **One PR, one fix.** A PR targets a single fix or a single narrowly-scoped feature. Scope creep is avoided at all costs. If you noticed a second problem while working, open a second PR.
- **Minimize lines changed and blast radius.** Prefer the smallest diff that correctly solves the problem. Drive-by refactors, formatting churn, and "while I was here" edits will get the PR rejected regardless of the core change's merit.
- **Large PRs need justification.** If a PR is large, the description must explain why it cannot be broken into separate PRs. "It was all one session" is not a justification.
- **Linear history.** Commit history must be linear; rebase your branch onto the target before opening or updating the PR. No merge commits, self-reverts, broken-up commits for a feature/fix inside a PR.
- **Clear commits.** Single-line conventional messages (`fix(swipes): preserve reasoning when switching swipes`). Each commit should build and make sense on its own; squash fixups before review.
- **Describe why.** The PR description states the problem, the root cause, the approach, and how it was tested, in plain language. Do not AI generate this and pass it through without human review and rewording so the maintainers can understand it.
- **Tests are required.** See [Tests](#tests). Non-trivial changes without tests will not be merged.
- **Fixes and performance changes need depth.** Think through and document edge cases, trade-offs, and possible regressions. A fix that trades one failure mode for another must describe this explicitly.

## Performance changes

All performance changes must be benchmarked **before and after**, with the numbers and methodology in the PR description. If a PR contains multiple independent performance changes, include a separate benchmark for each one, so each can be evaluated (and reverted) on its own. Performance claims without measurements will be treated as unsubstantiated.

## Use of AI coding tools

AI assistance is welcome. You are responsible for all lines you submit and must understand it. Do not pass an AI change without understanding it and its implications.

- A large, AI-generated, multi-scope PR will be rejected on the spot.
- All the rules above (single scope, minimal LOC, tests, benchmarks) apply with no AI exception.
- See [AGENTS.md](AGENTS.md) for the instructions we give coding agents working in this repo; human contributors using agents should hold their output to the same rules.

## Code conventions

- **Dry comments.** Default to no comment. Keep comments to 1-2 sentences carrying a constraint, invariant, or gotcha. Do not comment the plain code.
- **No private references.** Comments, test names, and log strings must not contain absolute machine paths, references to private documentation, or the names of specific third-party character cards.
- **Loud failures.** No silent `return ""` stubs, no warn-and-continue for failures.

## Repo layout

- `src/`: extension source. `backend.ts` (Spindle worker) and `frontend.ts` are the entry points.
- `tests/`: bun:test suite, organized by source area.
- `scripts/`: build assets, deploy, packaging, and host checks.

## Legal

CAT is licensed AGPL-3.0-only. By contributing you agree your contribution is licensed under the same terms.
