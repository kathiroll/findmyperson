package dev.findmyperson.encryptedstore

import android.content.Context
import android.content.pm.ApplicationInfo
import java.io.File

/**
 * Where the store lives on Android (plan 4.5): `<noBackupFilesDir>/fmp-store`.
 *
 * Android leaves noBackupFilesDir out of Auto Backup and of device-to-device transfer whatever
 * the manifest says, so the 30 days of location history and the wrapped key are outside
 * backups by location. The manifest of this library says the same thing a second time
 * (allowBackup="false" and rules that exclude everything), and [requireBackupDisabled] checks
 * at run time that the app's merged manifest still does.
 *
 * Nothing else may name a path for the store. StorePathsTest and the policy tests in
 * TypeScript fail if this stops being the no-backup directory.
 */
class StorePaths(noBackupFilesDir: File) {
    val directory = File(noBackupFilesDir, StoreContract.STORE_DIRECTORY_NAME)
    val database = File(directory, StoreContract.STORE_FILE_NAME)
    val keyFile = File(directory, StoreContract.KEY_FILE_NAME)

    /** The database with its -wal and -shm files: everything "delete all data" must remove. */
    val databaseFiles: List<File> =
        StoreContract.STORE_FILE_SUFFIXES.map { File(directory, StoreContract.STORE_FILE_NAME + it) }

    companion object {
        fun of(context: Context): StorePaths = StorePaths(context.noBackupFilesDir)

        /**
         * Fails closed if the installed app allows backup. This is the run-time twin of the CI
         * check on the manifest: if a dependency's manifest ever merges allowBackup back on,
         * the store refuses to open rather than let history reach a backup.
         */
        fun requireBackupDisabled(applicationFlags: Int) {
            if (applicationFlags and ApplicationInfo.FLAG_ALLOW_BACKUP != 0) {
                throw StoreException(
                    StoreException.BACKUP_NOT_EXCLUDED,
                    "the app's manifest has android:allowBackup enabled; it must be \"false\"",
                )
            }
        }
    }
}
