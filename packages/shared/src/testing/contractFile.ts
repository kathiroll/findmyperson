import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

/**
 * TEST SUPPORT, not exported from the package. Renders a value as the JSON text a file under
 * contracts/ must hold, formatted by the repo's own Prettier config so the committed file also
 * passes `pnpm format:check`.
 *
 * Used with vitest's toMatchFileSnapshot: the test fails when the committed file differs from
 * what the TypeScript source produces, and `pnpm test -u` rewrites the file. CI never rewrites.
 */
export async function contractJson(value: unknown, contractFile: URL): Promise<string> {
  const filepath = fileURLToPath(contractFile);
  const config = await resolveConfig(filepath);
  return format(JSON.stringify(value), { ...config, filepath });
}
