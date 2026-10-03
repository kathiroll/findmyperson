/**
 * The real native pieces, as `@findmyperson/encrypted-store/native`.
 *
 * A separate entry because importing it loads react-native and op-sqlite and looks the module
 * up in the registry at once, which throws anywhere the native code is not linked in: Node,
 * unit tests, an app built before the native projects exist. Code that only needs openStore,
 * the types or the test support imports the package root or `/testing`.
 *
 * The one place the app opens its store:
 *
 *   import { openStore } from '@findmyperson/encrypted-store';
 *   import { NativeEncryptedStore, opSqliteDriver } from '@findmyperson/encrypted-store/native';
 *   const store = await openStore({ vault: NativeEncryptedStore, driver: opSqliteDriver });
 */
export { default as NativeEncryptedStore } from './specs/NativeEncryptedStore';
export { opSqliteDriver } from './opSqliteDriver';
