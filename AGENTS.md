# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- No simulators or emulators; every claim about device behaviour is either verified from source/build output or listed as unverified in the PR and the relevant `m0/*/README.md`.
- Shared contracts: `packages/shared` is the only definition of the broadcast payload, signing, distance and H3 math, the widen-only edit rule, the store schema and API shapes; import from it, never redefine. Start at `packages/shared/README.md`. `contracts/README.md` there covers the files Kotlin and Swift must match and which of them are frozen versus generated (`pnpm exec vitest run packages/shared -u`, from the repo root). `src/store/ownership.ts` says which task may write which table. Outside `src/testing/` and tests that package must stay free of Node APIs.
- SQLCipher parameters: the real build reads `packages/shared/contracts/cipher-params.json`, pinned by a test to the M0 original `m0/store-proof/shared/cipher-params.json`, so change both together. In `m0/store-proof` run `npm run gen:cipher` and never hand-edit the generated TS/Kotlin/Swift constants. op-sqlite's Node build ignores the encryption key, so its Jest uses `@journeyapps/sqlcipher`; details in `m0/store-proof/README.md`.
- Native capture module: `packages/native-location-capture/src/specs/NativeLocationCapture.ts` is the one interface the Kotlin module, the Swift module and the in-memory fake (`…/fake`) all implement, and its comments are the contract; change it there first, never per platform. `contracts/` in that package is codegen output pinned by a test (`pnpm exec vitest run packages/native-location-capture -u`, from the repo root). Start at that package's README.
- App UI: build screens from `app/src/design-system/` (`import { … } from '../design-system'`); tokens live only in its `theme.ts`, extracted from the Design-canvas v2 mockups (the artifact outranks any older design notes). Component tests run against stubs, not real react-native; `app/assets/fonts/README.md` covers the bundled fonts.
- App navigation: route names, params and deep links are defined only in `app/src/navigation/routes.ts`; a screen task replaces its stub in `screens.tsx` and keeps the route name. Tests render the real graph against JS-only navigator doubles (`navigation/__tests__/stubs.tsx`). The `findmyperson://` scheme is not yet registered in native projects (none are checked in).
- Real-app builds: `build/*.sh` is the single path for local and CI builds (Android on every PR, iOS only on main/tags to save macOS runner cost); see `docs/BUILDING.md`. Signing comes only from env vars/CI secrets.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
