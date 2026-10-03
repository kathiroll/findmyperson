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
 *   iOS      <Application Support>/findmyperson-store, with isExcludedFromBackup set on the
 *            directory. iOS has no durable directory that is outside backups by location
 *            alone: Caches and tmp are, but the system may empty them, and 30 days of history
 *            must not vanish under storage pressure. Excluding the directory covers every file
 *            in it, including the -wal and -shm files SQLite recreates. The flag is read back
 *            on every open and the store refuses to open without it.
 *
 * The key is in neither directory on iOS (Keychain); on Android it is a file beside the store
 * that only the Keystore can unwrap.
 *
 * COMPATIBILITY. The capture modules in packages/native-location-capture were written before
 * this package and still carry their own copy of this logic (their README calls it a
 * stand-in). Every name and format below is the one those copies use, so that until they are
 * replaced by calls into this package, both find the same key and the same file. Do not
 * change one here without changing it there.
 */
export const ANDROID_STORE_DIRECTORY_NAME = 'fmp-store';
export const IOS_STORE_DIRECTORY_NAME = 'findmyperson-store';

/**
 * Android: the wrapped key, a file in the store directory. Its content is ASCII text,
 * base64(iv) ":" base64(ciphertext), where the plaintext is the key as 64 hex characters.
 */
export const ANDROID_KEY_FILE_NAME = 'store-key.wrapped';

/** Android: alias of the Keystore key that wraps the store key. */
export const ANDROID_KEYSTORE_ALIAS = 'fmp_store_wrap_v1';

/** iOS: the Keychain generic-password item that holds the store key as 64 hex characters. */
export const IOS_KEYCHAIN_SERVICE = 'dev.findmyperson.store';
export const IOS_KEYCHAIN_ACCOUNT = 'store-key-v1';

/** The store file and the two files SQLite keeps beside it in WAL mode. */
export const STORE_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;
