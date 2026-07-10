# Contributing

Thanks for your interest in the little big brain TypeScript SDK!

## How this repository works

This repository is a **one-way export** from the private little big brain
monorepo. Canonical development, code review, and CI happen there; every commit
on `main` here is an allow-listed snapshot that already passed those gates.

Practical consequences:

- **Issues are the best way to contribute.** Bug reports with a minimal
  reproduction, API-ergonomics feedback, and documentation fixes are all
  triaged directly and usually turn around quickly.
- **Pull requests are welcome but are not merged directly.** A maintainer
  ports an accepted patch to the private repository, lands it through private
  CI, and the next export brings it back here — at which point your PR is
  closed with a reference to the canonical commit. You keep authorship credit
  in the release notes.
- Generated files (`src/schema.ts`, `contracts/openapi.json`) are produced
  from the server's Rust API types in the canonical monorepo. PRs that
  hand-edit them can't be accepted; describe the contract problem in an issue
  instead.

## Developing

Node ≥ 18; the package is self-contained with its own lockfile:

```sh
npm ci
npm run typecheck && npm test
npm run pack:check   # build + publint + arethetypeswrong
npx eslint src       # uses eslint.config.js at the repo root
```

## Releases

When a canonical sync lands a package version that is not yet on npm, CI runs
the release suite and pauses at the protected `npm` environment. A maintainer
approves that deployment; trusted publishing uploads
`@littlebigbrain/client`, then CI creates the matching `vX.Y.Z` tag and GitHub
Release. No local tag push or registry token is required.

## Conduct & security

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).
Never report security issues in public GitHub issues.
