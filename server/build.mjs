// Bundles the process entries into dist/ as plain ESM that `node` runs with no flags.
// The sources import each other (and @findmyperson/shared, which ships as TypeScript) without
// file extensions, which Node's own type stripping cannot resolve, so they are bundled rather
// than run in place. The server's own npm dependencies stay external and load from node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: {
    main: 'src/main.ts',
    cli: 'src/shards/cli.ts',
    'match-harness': 'src/harness/cli.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: ['fastify', 'zod'],
  // Bundled CommonJS dependencies may call require().
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
