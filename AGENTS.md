# Agent instructions for CAT

Instructions for AI coding agents working in this repository. You must also follow [CONTRIBUTING.md](CONTRIBUTING.md).

All changes must be run through YAGNI+SOLID+DRY+KISS principles and only what passes should be kept. Enforce this before every commit. Most commits, you'll find you built too much shit and have to delete most of it.

Do not scope creep at any cost.

## What this project is

A Lumiverse extension that generates parallel swipes using different presets and connections.

## Commands

```bash
bun install                     # setup
bun run build                   # typecheck + bundles into dist/
bun run test                    # must pass before any commit
bun run typecheck               # whole-tree typecheck including tests
bun run test:host ../Lumiverse   # isolated host checks
```

`dist/` is committed. Any change to `src/` must be followed by `bun run build` and the rebuilt `dist/` included in the same commit.

## Rules

1. **Single scope.** One change per branch/PR: a single fix or one narrowly-scoped feature. Do not bundle large refactors, formatting, or unrelated improvements with a fix. Large multi-scope changes are rejected on the spot. Minimize lines changed and blast radius.
2. **Tests are mandatory.** Every change ships with a test. Bug-fix tests must fail without the fix and pass with it. Place tests under `tests/` by source area. Tests must run on a clean clone.
3. **Benchmarks for performance work.** Every performance change needs before/after numbers with methodology. Multiple performance changes in one PR each need their own benchmark.
4. **Consider the failure modes.** For fixes and performance changes, reason explicitly about edge cases, trade-offs, and regressions before finishing, and record the conclusions in the PR description.
5. **Linear history, clear commits.** Rebase; never merge-commit inside a branch. Single-line conventional commit messages (`fix(swipes): ...`). No reverts. Each commit should contain an individually reviewable portion and should NOT be stretched across multiple commits.
6. **No private references.** Comments, test names, and log strings must never contain absolute machine paths, private documentation references, or names of specific third-party character cards. Comments are 1-2 sentences, state the why (constraint, invariant, gotcha), and default to absent. No em dashes in comments or log strings. No explaining the code below.
7. **Loud failures.** Unsupported surfaces throw typed errors. Never add silent fallbacks, `return ""` stubs, or warn-and-continue paths for failures. Silent errors are the bane of tracability.
8. **Rigorously review.** You must spawn a context-ablated subagent to review before you declare it ready for PR or make the PR. If the subagent finds any issues, you must address them before the PR, then run another round. This must be done on loop until no significant blocking issue is found. The prompt to give to the context-ablated subagent is as follows:

```text
### Notes for AI-assisted review

Act as a senior engineer doing a production PR review. Goal: find defects and risky assumptions, not style nitpicks.

Focus only on critical issues: potential bugs, correctness, security (including PHI exposure), reliability, and performance.

Rules:
- Do not invent problems to seem thorough.
- Do not comment on style, formatting, or naming unless it causes a bug.
- Skip anything a formatter, linter, or CI should enforce.
- If you're unsure, ask a targeted question instead of guessing.

Output:
- BLOCKING: issues that must be fixed before merge, each with the
  exact line and a concrete fix.
- If there are none, give a simple approval: "✅ lgtm"

Sources:
- https://www.josecasanova.com/blog/claude-code-review-prompt
- https://dev.to/nongdyz_d9c3069b1acb2a08c/10-ai-prompts-that-make-code-review-actually-useful-430i
- https://dev.to/novaelvaris/a-code-review-prompt-that-finds-bugs-not-nitpicks-2apc
```

## Layout

- `src/backend/` session ownership, storage, and variables · `src/generation/` parallel streams and swipe selection · `src/ui/` drawer, hotbar, and cat photos.
