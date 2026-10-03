package dev.findmyperson.encryptedstore

import android.content.pm.ApplicationInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class StorePathsTest {
    private val noBackup = File("/data/user/0/dev.findmyperson/no_backup")
    private val paths = StorePaths(noBackup)

    @Test
    fun everyStoreFileIsInsideTheNoBackupDirectory() {
        val all = paths.databaseFiles + paths.keyFile + paths.database + paths.directory
        for (file in all) {
            assertTrue("$file is outside $noBackup", file.path.startsWith(noBackup.path + File.separator))
        }
        assertEquals(File(noBackup, "fmp-store"), paths.directory)
    }

    @Test
    fun theDatabaseFilesAreTheStoreFileAndItsWalAndShm() {
        assertEquals(
            listOf("findmyperson.db", "findmyperson.db-wal", "findmyperson.db-shm"),
            paths.databaseFiles.map { it.name },
        )
        assertEquals(paths.database, paths.databaseFiles.first())
        assertEquals(paths.directory, paths.keyFile.parentFile)
    }

    @Test
    fun anAppThatAllowsBackupIsRefused() {
        val error = expectThrows<StoreException> {
            StorePaths.requireBackupDisabled(ApplicationInfo.FLAG_ALLOW_BACKUP or ApplicationInfo.FLAG_HAS_CODE)
        }
        assertEquals(StoreException.BACKUP_NOT_EXCLUDED, error.code)
    }

    @Test
    fun anAppThatForbidsBackupIsAccepted() {
        StorePaths.requireBackupDisabled(ApplicationInfo.FLAG_HAS_CODE)
        StorePaths.requireBackupDisabled(0)
    }
}
