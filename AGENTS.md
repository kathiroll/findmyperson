# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- No simulators or emulators; every claim about device behaviour is either verified from source/build output or listed as unverified in the PR and the relevant `m0/*/README.md`.
- On-device store (`m0/store-proof/`): the SQLCipher parameters live only in `m0/store-proof/shared/cipher-params.json`; edit it, run `npm run gen:cipher`, never hand-edit the generated TS/Kotlin/Swift constants. op-sqlite's Node build ignores the encryption key, so Jest uses `@journeyapps/sqlcipher`; details in `m0/store-proof/README.md`.
- App UI: build screens from `app/src/design-system/` (`import { … } from '../design-system'`); tokens live only in its `theme.ts`, extracted from the Design-canvas v2 mockups (the artifact outranks any older design notes). Component tests run against stubs, not real react-native; `app/assets/fonts/README.md` covers the bundled fonts.

- Real-app builds: `build/*.sh` is the single path for local and CI builds (Android on every PR, iOS only on main/tags to save macOS runner cost); see `docs/BUILDING.md`. Signing comes only from env vars/CI secrets.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
