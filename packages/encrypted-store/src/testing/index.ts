/**
 * `@findmyperson/encrypted-store/testing`: a real encrypted store for Node tests.
 *
 *   const vault = createTestVault(mkdtempSync(join(tmpdir(), 'fmp-')));
 *   const store = await openStore({ vault, driver: nodeSqlcipherDriver() });
 *
 * Uses Node and a native SQLCipher build freely; never import it from app code.
 */
export { nodeSqlcipherDriver } from './nodeSqlcipherDriver';
export { createTestVault, type TestVault } from './testVault';
