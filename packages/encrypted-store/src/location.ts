/**
 * Where the store lives on each platform, and why there (plan 4.5).
 *
 * The rule is the same on both: one directory that holds nothing but the store, that the
 * platform never backs up, and that only native code names. JavaScript receives the path from
 * `getStoreDirectory()` and never builds one.
 *
 *   Android  <noBackupFilesDir>/fmp-store. Android leaves noBackupFilesDir out of Auto Backup
 *            and of device-to-device transfer, whatever the manifest says. The manifest says it
 *            too (allowBackup="false" plus rules that exclude everything), and
 *            android/src/main/AndroidManifest.xml of this package carries those attributes
 *            into the app's merged manifest.
 *   iOS      <Application Support>/fmp-store, with isExcludedFromBackup set on the directory.
 *            iOS has no durable directory that is outside backups by location alone: Caches
 *            and tmp are, but the system may empty them, and 30 days of history must not
 *            vanish under storage pressure. Excluding the directory covers every file in it,
 *            including the -wal and -shm files SQLite recreates. The flag is read back on
 *            every open and the store refuses to open without it.
 *
 * The key is in neither directory: Keychain on iOS, and on Android a file beside the store
 * that only the Keystore can unwrap.
 */
export const STORE_DIRECTORY_NAME = 'fmp-store';

/** Android: the wrapped key, a file in the store directory. */
export const ANDROID_KEY_FILE_NAME = 'store-key.v1';

/** Android: alias of the Keystore key that wraps the store key. */
export const ANDROID_KEYSTORE_ALIAS = 'fmp_store_wrap_v1';

/** iOS: the Keychain generic-password item that holds the store key. */
export const IOS_KEYCHAIN_SERVICE = 'dev.findmyperson.store';
export const IOS_KEYCHAIN_ACCOUNT = 'store-key-v1';

/** The store file and the two files SQLite keeps beside it in WAL mode. */
export const STORE_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;
