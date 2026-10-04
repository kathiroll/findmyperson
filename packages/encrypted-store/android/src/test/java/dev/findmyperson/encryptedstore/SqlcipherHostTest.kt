package dev.findmyperson.encryptedstore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * THE REAL KOTLIN STORE AND THE REAL JNI CODE, on real SQLCipher, on the JVM.
 *
 * Runs only when the build was given -PfmpHostSqlcipher (build.gradle), which compiles
 * src/main/cpp for this machine and links it, as on a phone, against a separate library named
 * libop-sqlite that holds SQLCipher built from op-sqlite's source. The CI job passes the flag.
 *
 * What this proves: the JNI code and SqlcipherConnection are correct against the SQLCipher
 * release op-sqlite ships, the store opens, verifies and writes a real encrypted file, and two
 * connections made through one library exclude each other. What it cannot prove is the Android
 * link itself; scripts/check-native-libs.ts reads that from the built APK.
 */
class SqlcipherHostTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val paths by lazy { StorePaths(folder.root) }
    private val wrapper = SoftwareKeyWrapper()
    private val vault by lazy { StoreKeyVault(paths.keyFile, wrapper) }

    private val sample = LocationSampleRow(
        tsUtc = 1_700_000_000,
        lat = 12.9716,
        lon = 77.5946,
        accuracyM = 12.0,
        source = "wm",
        h3R7 = "8760145b4ffffff",
        h3R5 = "8560145bfffffff",
    )

    @Before
    fun onlyWithTheHostBuild() {
        assumeTrue("needs -PfmpHostSqlcipher", System.getProperty("fmp.hostSqlcipher") == "true")
    }

    private fun store() = EncryptedStore(paths, vault, SqlcipherDatabase) { 0 }

    /** A second connection to the store file, as the one op-sqlite holds for TypeScript is. */
    private fun connect(keyHex: String? = null, create: Boolean = true): SqlcipherConnection {
        paths.directory.mkdirs()
        val key = keyHex ?: vault.getOrCreateKeyHex()
        val connection = SqlcipherConnection.open(paths.database, StoreKeys.keyLiteral(key), create)
        StoreContract.APPLY_PRAGMAS.forEach { connection.scalar(it) }
        return connection
    }

    /** Plays TypeScript's openStore: creates the file and runs the real version-1 migration. */
    private fun migrate() {
        val statements = File(checkNotNull(System.getProperty("fmp.migrationSql"))).readText().split(Regex("(?m)^;$"))
        connect().use { typescript ->
            typescript.scalar("PRAGMA journal_mode = ${StoreContract.JOURNAL_MODE}")
            statements.map { it.trim() }.filter { it.isNotEmpty() }.forEach { typescript.execute(it) }
        }
    }

    @Test
    fun theKotlinSideIsBoundToTheOpSqliteLibraryAndHoldsNoSqliteOfItsOwn() {
        val library = File(SqlcipherConnection.engineLibrary())
        assertEquals(SqlcipherConnection.ENGINE_LIBRARY_NAME, library.nameWithoutExtension)
        assertNotEquals("lib${SqlcipherNative.LIBRARY}", library.nameWithoutExtension)
        assertTrue(library.isFile)
    }

    @Test
    fun aNewFileOpensAsSqlcipher4WithEveryPinnedParameterInEffect() {
        paths.directory.mkdirs()
        val db = SqlcipherDatabase.open(paths.database, StoreContract.KEY_VECTOR_HEX)
        try {
            StoreVerifier.verifyCipher(db)
            assertTrue(db.scalar("PRAGMA cipher_version")!!.startsWith("4."))
            assertEquals(StoreContract.BUSY_TIMEOUT_MS.toString(), db.scalar("PRAGMA busy_timeout"))
        } finally {
            db.close()
        }
        // Encrypted on disk: a plaintext SQLite file starts with this text.
        assertFalse(paths.database.readBytes().decodeToString(0, 16).startsWith("SQLite format 3"))
    }

    @Test
    fun aSampleWrittenByTheStoreIsReadBackByAnotherConnection() {
        migrate()
        val store = store()
        assertEquals(1L, store.insertLocationSample(sample))
        assertEquals(2L, store.insertLocationSample(sample.copy(tsUtc = 1_700_000_900)))
        assertEquals("1700000900", store.readScalar("SELECT max(ts_utc) FROM location_sample"))
        assertEquals("1", store.readScalar("SELECT count(*) FROM location_sample WHERE ts_utc > ?", listOf(1_700_000_000L)))

        connect().use { typescript ->
            assertEquals("2", typescript.scalar("SELECT count(*) FROM location_sample"))
            assertEquals(
                "12.9716|77.5946|12.0|wm|8760145b4ffffff|8560145bfffffff",
                typescript.scalar(
                    "SELECT lat || '|' || lon || '|' || accuracy_m || '|' || source || '|' || h3_r7 || '|' || h3_r5 " +
                        "FROM location_sample WHERE id = 1",
                ),
            )
        }
        store.close()
    }

    @Test
    fun aStoreTypeScriptHasNotMigratedIsNotWrittenTo() {
        val error = expectThrows<StoreException> { store().insertLocationSample(sample) }
        assertEquals(StoreException.SCHEMA_MISMATCH, error.code)
    }

    @Test
    fun aWrongKeyIsReportedAndNothingIsRead() {
        migrate()
        val other = "ff".repeat(StoreContract.KEY_BYTES)
        val error = expectThrows<StoreException> { SqlcipherDatabase.open(paths.database, other) }
        assertEquals(StoreException.BAD_KEY_OR_PARAMS, error.code)
        assertTrue(error.message!!.contains("file is not a database"))
        assertFalse(error.message!!.contains(other))
    }

    @Test
    fun twoWritersThroughOneLibraryExcludeEachOther() {
        // The reason for one library. `typescript` plays the connection op-sqlite holds; the
        // other is a native writer. While one is inside a write transaction the other must be
        // told the file is busy. Two copies of SQLite in one process would both go ahead.
        migrate()
        val typescript = connect()
        val native = connect()
        try {
            native.busyTimeout(0)
            typescript.execute("BEGIN IMMEDIATE")
            typescript.execute("INSERT INTO kv (k, v) VALUES ('held', '1')")

            val refused = expectThrows<SqlcipherException> {
                native.insert(
                    StoreContract.INSERT_LOCATION_SAMPLE_SQL,
                    listOf(sample.tsUtc, sample.lat, sample.lon, sample.accuracyM, sample.source, sample.h3R7, sample.h3R5),
                )
            }
            assertEquals(SQLITE_BUSY, refused.resultCode)
            // A reader is not blocked by a writer in WAL, and does not see the open transaction.
            assertNull(native.scalar("SELECT v FROM kv WHERE k = 'held'"))

            typescript.execute("COMMIT")
            assertEquals(
                1L,
                native.insert(
                    StoreContract.INSERT_LOCATION_SAMPLE_SQL,
                    listOf(sample.tsUtc, sample.lat, sample.lon, sample.accuracyM, sample.source, sample.h3R7, sample.h3R5),
                ),
            )
            assertEquals("1", native.scalar("SELECT v FROM kv WHERE k = 'held'"))
            assertEquals("1", typescript.scalar("SELECT count(*) FROM location_sample"))
        } finally {
            typescript.close()
            native.close()
        }
    }

    @Test
    fun aWriterThatWaitsGetsItsTurnWhenTheOtherCommits() {
        migrate()
        val typescript = connect()
        val store = store()
        try {
            store.check()
            typescript.execute("BEGIN IMMEDIATE")
            val release = Thread {
                Thread.sleep(300)
                typescript.execute("COMMIT")
            }.apply { start() }
            // Blocks on the busy timeout of the contract, then goes through.
            assertEquals(1L, store.insertLocationSample(sample))
            release.join()
        } finally {
            typescript.close()
            store.close()
        }
    }

    @Test
    fun textCrossesAsUtf8AndUpdatesReportTheirRowCount() {
        migrate()
        connect().use { db ->
            val text = "Bengaluru ಬೆಂಗಳೂರು 😀"
            assertEquals(text, db.scalar("SELECT ?", listOf(text)))
            assertNull(db.scalar("SELECT ?", listOf(null)))
            assertNull(db.scalar("SELECT 1 WHERE 0"))
            db.execute("INSERT INTO kv (k, v) VALUES (?, ?)", listOf("a", text))
            db.execute("INSERT INTO kv (k, v) VALUES (?, ?)", listOf("b", "x"))
            assertEquals(text, db.scalar("SELECT v FROM kv WHERE k = ?", listOf("a")))
            assertEquals(2, db.update("UPDATE kv SET v = v || '!' WHERE k IN ('a', 'b')", emptyList()))
            assertEquals(0, db.update("UPDATE kv SET v = '' WHERE k = ?", listOf("absent")))

            val error = expectThrows<SqlcipherException> { db.execute("INSERT INTO no_such_table VALUES (?)", listOf("secret")) }
            assertTrue(error.message!!.contains("no such table"))
            assertFalse(error.message!!.contains("secret"))
            expectThrows<IllegalArgumentException> { db.scalar("SELECT ?", listOf(listOf(1))) }
        }
    }

    @Test
    fun aWriterThatMustNotCreateTheStoreDoesNot() {
        paths.directory.mkdirs()
        expectThrows<SqlcipherException> { connect(StoreContract.KEY_VECTOR_HEX, create = false) }
        assertFalse(paths.database.exists())
    }

    @Test
    fun aClosedConnectionRefusesWorkAndClosingTwiceIsHarmless() {
        val db = connect()
        db.close()
        db.close()
        expectThrows<SqlcipherException> { db.scalar("SELECT 1") }
    }

    @Test
    fun deleteAllDataRemovesTheRealFilesAndTheNextStoreHasANewKey() {
        migrate()
        val store = store()
        store.insertLocationSample(sample)
        val oldKey = store.keyHex()
        assertTrue(paths.database.exists())

        store.deleteAllData()
        assertTrue(paths.databaseFiles.none { it.exists() })
        assertFalse(paths.keyFile.exists())

        assertNotEquals(oldKey, store.keyHex())
        assertEquals(StoreException.SCHEMA_MISMATCH, expectThrows<StoreException> { store.check() }.code)
        store.close()
    }

    private companion object {
        const val SQLITE_BUSY = 5
    }
}
