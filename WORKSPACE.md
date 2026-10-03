# Workspace guide

This file covers the real build (everything outside `m0/`). The top-level [README](README.md) describes the project itself.

## What a monorepo workspace is, and why one is used here

A monorepo workspace is one git repository holding several packages that can depend on each other locally. Here the app, the shared schema and matching logic, the native location module, and the backend all live together, so `app` and `server` import the same payload types from `packages/shared` with no publishing step and no version drift. The package manager links them with symlink-like local references and installs everything once, with one lockfile. Think of it as a Next.js monorepo with several `package.json` files that can import each other.

## Layout

| Path                                | What it is                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `app/`                              | React Native app (New Architecture, TypeScript). Native projects are added later      |
| `packages/shared/`                  | Payload schemas (zod) and pure logic such as H3 sharding math. Used by app and server |
| `packages/native-location-capture/` | Turbo Native Module package for background location capture                           |
| `packages/encrypted-store/`         | The on-device encrypted store: open, migrate, key, backup exclusion, native writer    |
| `server/`                           | Backend                                                                               |
| `docs/`                             | Documentation for the real build                                                      |
| `m0/`                               | Finished M0 trial apps. Not part of the workspace, never touched by tooling           |

Package names are `@findmyperson/app`, `@findmyperson/shared`, `@findmyperson/native-location-capture`, `@findmyperson/encrypted-store` and `@findmyperson/server`. To depend on one, add `"@findmyperson/shared": "workspace:*"` to the dependencies.

## Tooling

- **Workspace tool: pnpm** (pinned in `package.json` as `packageManager`). Fast, strict about undeclared dependencies, and has first-class `workspace:*` links. `.npmrc` sets `node-linker=hoisted` so React Native's Metro bundler and native autolinking see a flat `node_modules`.
- **Test runner: Vitest.** TypeScript works with no extra setup, and its `projects` option runs every workspace member from one root config.
- **TypeScript strict** with one `tsconfig.base.json` at the root; each member has a small `tsconfig.json` that extends it.
- **ESLint** (flat config, `eslint.config.js`) and **Prettier** (`.prettierrc.json`) are configured once at the root and cover every member.
- Pre-installed for later tasks: `react-native` 0.87 (New Architecture is the default), `zod`, `h3-js`, and `@op-engineering/op-sqlite`. No Android or iOS native dependencies are added yet.

## Install

Needs Node 24 or newer. Then enable pnpm through Corepack, which ships with Node, and install:

```sh
corepack enable
pnpm install
```

## Everyday commands (run from the repo root)

| Command                                   | What it does                                             |
| ----------------------------------------- | -------------------------------------------------------- |
| `pnpm test`                               | Run the unit tests of every workspace member             |
| `pnpm typecheck`                          | Run `tsc` in every member                                |
| `pnpm lint`                               | ESLint across the repo                                   |
| `pnpm format`                             | Rewrite files with Prettier (`format:check` only checks) |
| `pnpm check`                              | Everything CI runs, in the same order                    |
| `pnpm --filter @findmyperson/shared test` | Run one member's tests                                   |

## CI

`.github/workflows/ci.yml` runs on every pull request (and pushes to `main`) as a single job on one runner: install once with `pnpm install --frozen-lockfile` (cached by lockfile), then typecheck, lint, format check, and unit tests across all workspaces. A single job avoids paying for install several times. The expected time on a trivial PR is about 1 to 2 minutes. If this job passes locally with `pnpm check`, it should pass in CI.

## Building installable apps

Release and debug build scripts, signing secrets and the Android/iOS CI jobs are described in [docs/BUILDING.md](docs/BUILDING.md).
