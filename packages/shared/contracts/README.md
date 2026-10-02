# Contract files

These files are the parts of `@findmyperson/shared` that code outside TypeScript has to agree with: the Kotlin and Swift capture modules, and anyone writing an independent reader or publisher. Each is plain JSON or SQL so a native test can load it directly.

There are two kinds, and they are maintained differently.

## Golden vectors (frozen, hand-reviewed)

Inputs chosen by hand, expected outputs recorded once. A test never rewrites them. If one stops passing, the code changed behaviour and that is a contract break to look at, not a fixture to refresh.

| File                          | What must match it                                                                                           | Who must pass it                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `geo-vectors.json`            | Haversine distances, res-7 cell of a point, its res-5 and res-3 parents, neighbour rings, search-area covers | TypeScript, Kotlin, Swift          |
| `canonical-json-vectors.json` | Canonical JSON text (RFC 8785) for a value                                                                   | TypeScript, any third-party signer |
| `signing-vectors.json`        | The exact bytes signed, and the Ed25519 signature, for a query, a bundle and an index                        | TypeScript, any third-party signer |
| `widening-vectors.json`       | The verdict of the widen-only edit rule for a pair of match criteria                                         | TypeScript (server and app)        |
| `cipher-params.json`          | The SQLCipher parameters of the on-device store                                                              | TypeScript, Kotlin, Swift          |

Notes for a native implementer:

- **Cells must match exactly, as strings.** H3 ids are 15 lowercase hex characters.
- **`h3_r5` is the res-5 parent of the res-7 cell, not the res-5 cell containing the point.** The two differ near shard edges. `geo-vectors.json` carries both (`h3_r5` and `h3_r5_containing`) and includes points where they differ, `mumbai` among them. Write `h3_r5`.
- **Distances must match within `distance_tolerance_m`**, using `earth_radius_m` and the haversine formula as written in `src/geo/distance.ts`. The vectors avoid near-antipodal pairs, where haversine is ill-conditioned and platforms legitimately differ by more.
- **Cell vectors come from h3-js 4.5.0** (H3 core 4.x) and include the worked example from the H3 documentation. Distance values were produced by the TypeScript implementation and cross-checked against H3's own haversine.
- **The signing key in `signing-vectors.json` is public** (test vector 1 of RFC 8032). It must never be in a real build's trusted keys.
- `cipher-params.json` mirrors the cipher fields of `m0/store-proof/shared/cipher-params.json`, which proved the values on real SQLCipher builds. A test fails if the two disagree.

To add a vector: add the input, run the tests, and take the expected value from the failure only after checking it against a second implementation or by hand. `widening-vectors.json` records the arithmetic for each case in `why`.

## Generated files (derived from the TypeScript source)

These are copies of definitions that live in `src/`. A test compares each file with what the source produces and fails on any difference. `pnpm --filter @findmyperson/shared test -u` rewrites them; CI never does.

| File                          | Generated from                                          | For                                                           |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `migration-v1.sql`            | `MIGRATION_V1` in `src/store/migrations.ts`             | Native unit tests that need the real schema                   |
| `native-writer.json`          | `NATIVE_WRITER_CONTRACT` in `src/store/nativeWriter.ts` | The only statements a native module may run against the store |
| `broadcast-query.schema.json` | `BroadcastQuerySchema`                                  | Third-party readers and publishers                            |
| `shard-bundle.schema.json`    | `ShardBundleSchema`                                     | Third-party readers and publishers                            |
| `shard-index.schema.json`     | `ShardIndexSchema`                                      | Third-party readers and publishers                            |

`migration-v1.sql` is a special case: a released migration is frozen. Once the app has shipped, a difference there means someone edited version 1, and the fix is to undo the edit and add a new migration, not to run `-u`.

In the `.sql` file statements are separated by a line holding only `;`.

## The signing scheme in one paragraph

A signed document is a JSON object with a `key_id` and a `sig`. The signed bytes are the UTF-8 encoding of `findmyperson.<kind>.v1`, a newline, and the canonical JSON (RFC 8785) of the document with its `sig` member removed, where `<kind>` is `query`, `bundle` or `index`. `sig` is `ed25519:` followed by the 64-byte signature in unpadded base64url. Members a reader does not know are still part of the signed bytes, so verify the document as received and only then apply a schema. `signing-vectors.json` gives the exact text for each kind.
