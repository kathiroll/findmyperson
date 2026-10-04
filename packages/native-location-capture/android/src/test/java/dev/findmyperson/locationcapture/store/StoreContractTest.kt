package dev.findmyperson.locationcapture.store

import dev.findmyperson.locationcapture.Contracts
import dev.findmyperson.locationcapture.Contracts.strings
import dev.findmyperson.locationcapture.core.H3
import dev.findmyperson.locationcapture.core.HOME_LAT
import dev.findmyperson.locationcapture.core.HOME_LON
import dev.findmyperson.locationcapture.core.PurgeCounts
import dev.findmyperson.locationcapture.core.StoredSample
import dev.findmyperson.locationcapture.core.T0
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.sql.Connection
import java.sql.DriverManager

/**
 * The store contract of packages/shared, from the native side:
 *   - the constants the build generated are the contract files' values;
 *   - the insert statement, bound the way this module binds it, writes the row TypeScript
 *     expects into the real schema (contracts/migration-v1.sql), run on a real SQLite;
 *   - the purge statements, run the way this module runs them, delete what is past retention
 *     from that schema and nothing else;
 *   - a store at another schema version is refused, and a drifted cipher parameter is caught.
 *
 * What is not run here is SQLCipher itself: its Android library cannot load on a JVM. The
 * connection is plain SQLite behind the same `SqlDatabase` interface the SQLCipher connection
 * implements, so the statements and their binding are the production ones.
 */
class StoreContractTest {
    private val writer = Contracts.json(Contracts.shared("native-writer.json"))
    private val cipher = Contracts.json(Contracts.shared("cipher-params.json"))

    private lateinit var connection: Connection
    private lateinit var db: JdbcDatabase

    /** Plain SQLite. [pragmas] overrides what a `PRAGMA name` reads back, to play SQLCipher. */
    private class JdbcDatabase(private val connection: Connection) : SqlDatabase {
        val pragmas = mutableMapOf<String, String?>()

        override fun scalar(sql: String): String? {
            val pragma = sql.removePrefix("PRAGMA ").trim()
            if (pragma in pragmas) return pragmas[pragma]
            connection.createStatement().use { statement ->
                // A pragma the engine does not know yields no rows, as on Android.
                if (!statement.execute(sql)) return null
                statement.resultSet.use { rows -> return if (rows.next()) rows.getString(1) else null }
            }
        }

        override fun execute(sql: String, args: Array<Any?>) {
            connection.prepareStatement(sql).use { statement ->
                args.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
                statement.executeUpdate()
            }
        }

        override fun update(sql: String, args: LongArray): Int =
            connection.prepareStatement(sql).use { statement ->
                args.forEachIndexed { index, value -> statement.setLong(index + 1, value) }
                statement.executeUpdate()
            }

        override fun <T> transaction(block: () -> T): T {
            connection.autoCommit = false
            try {
                val result = block()
                connection.commit()
                return result
            } catch (e: Exception) {
                connection.rollback()
                throw e
            } finally {
                connection.autoCommit = true
            }
        }

        override fun close() = connection.close()
    }

    @Before
    fun migrate() {
        connection = DriverManager.getConnection("jdbc:sqlite::memory:")
        // contracts/migration-v1.sql: statements separated by a line holding only ";".
        val statements = Contracts.shared("migration-v1.sql").readText().split(Regex("(?m)^;$"))
        connection.createStatement().use { statement ->
            statements.map { it.trim() }.filter { it.isNotEmpty() }.forEach(statement::execute)
        }
        db = JdbcDatabase(connection)
    }

    @After
    fun close() = connection.close()

    private fun sample(tsUtc: Long = T0): StoredSample {
        val cells = H3.sampleCells(HOME_LAT, HOME_LON)
        return StoredSample(tsUtc, HOME_LAT, HOME_LON, 12.5, "wm", cells.h3R7, cells.h3R5)
    }

    // ---- the generated constants ----

    @Test
    fun `the generated constants are the contract files' values`() {
        assertEquals(writer.getInt("schemaVersion"), StoreContract.SCHEMA_VERSION)
        assertEquals(writer.getString("readSchemaVersionSql"), StoreContract.READ_SCHEMA_VERSION_SQL)
        assertEquals(writer.getString("storeFileName"), StoreContract.STORE_FILE_NAME)
        assertEquals(writer.getString("insertLocationSampleSql"), StoreContract.INSERT_LOCATION_SAMPLE_SQL)
        assertEquals(writer.getJSONArray("sampleSources").strings(), StoreContract.SAMPLE_SOURCES.toList())

        assertEquals(writer.getLong("retentionSec"), StoreContract.RETENTION_SEC)
        assertEquals(writer.getString("deleteSamplesBeforeSql"), StoreContract.DELETE_SAMPLES_BEFORE_SQL)
        assertEquals(writer.getString("deleteStaysEndedBeforeSql"), StoreContract.DELETE_STAYS_ENDED_BEFORE_SQL)
        assertEquals(writer.getString("trimStaysStartedBeforeSql"), StoreContract.TRIM_STAYS_STARTED_BEFORE_SQL)
        assertEquals(writer.getString("rewindStayCursorSql"), StoreContract.REWIND_STAY_CURSOR_SQL)
        // The whole contract. A key added to it needs a decision here; the two visit statements are iOS's.
        assertEquals(
            setOf(
                "schemaVersion", "readSchemaVersionSql", "storeFileName", "insertLocationSampleSql", "sampleSources",
                "insertVisitStaySql", "closeVisitStaySql", "retentionSec", "deleteSamplesBeforeSql",
                "deleteStaysEndedBeforeSql", "trimStaysStartedBeforeSql", "rewindStayCursorSql",
            ),
            writer.keys().asSequence().toSet(),
        )

        assertEquals(cipher.getInt("sqlcipherMajor"), StoreContract.SQLCIPHER_MAJOR)
        assertEquals(cipher.getInt("cipherCompatibility"), StoreContract.CIPHER_COMPATIBILITY)
        assertEquals(cipher.getInt("pageSizeBytes"), StoreContract.PAGE_SIZE_BYTES)
        assertEquals(cipher.getInt("kdfIterations"), StoreContract.KDF_ITERATIONS)
        assertEquals(cipher.getString("kdfAlgorithm"), StoreContract.KDF_ALGORITHM)
        assertEquals(cipher.getString("hmacAlgorithm"), StoreContract.HMAC_ALGORITHM)
        assertEquals(cipher.getInt("keyBytes"), StoreContract.KEY_BYTES)
        assertEquals(cipher.getString("journalMode"), StoreContract.JOURNAL_MODE)
    }

    @Test
    fun `the pragma lists are the ones TypeScript builds from the same file`() {
        // packages/shared/src/store/cipher.ts, buildApplyPragmas and buildReadBack.
        assertEquals(
            listOf(
                "PRAGMA cipher_compatibility = 4",
                "PRAGMA cipher_page_size = 4096",
                "PRAGMA kdf_iter = 256000",
                "PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512",
                "PRAGMA cipher_hmac_algorithm = HMAC_SHA512",
            ),
            CipherPragmas.APPLY,
        )
        assertEquals(
            listOf("cipher_page_size", "kdf_iter", "cipher_kdf_algorithm", "cipher_hmac_algorithm"),
            CipherPragmas.READ_BACK.map { it.first },
        )
    }

    @Test
    fun `the key literal matches the contract's key vector`() {
        val vector = cipher.getJSONObject("keyVector")
        assertEquals(vector.getString("literal"), StoreKeys.keyLiteral(vector.getString("hex")))
        assertEquals(vector.getString("literal"), StoreKeys.keyLiteral(vector.getString("hex").uppercase()))
        assertThrows(IllegalArgumentException::class.java) { StoreKeys.keyLiteral("abc") }
        assertThrows(IllegalArgumentException::class.java) { StoreKeys.keyLiteral("z".repeat(64)) }

        val generated = StoreKeys.randomKeyHex()
        assertTrue(Regex("^[0-9a-f]{64}$").matches(generated))
        assertTrue(generated != StoreKeys.randomKeyHex())
    }

    // ---- the one write ----

    @Test
    fun `the insert writes the row TypeScript reads, cells included`() {
        StoreRules.requireSchemaVersion(db)
        StoreRules.insert(db, sample(T0))
        StoreRules.insert(db, sample(T0 + 900))

        connection.createStatement().use { statement ->
            statement.executeQuery("SELECT id, ts_utc, lat, lon, accuracy_m, source, h3_r7, h3_r5 FROM location_sample ORDER BY id").use { rows ->
                assertTrue(rows.next())
                assertEquals(1, rows.getInt("id"))
                assertEquals(T0, rows.getLong("ts_utc"))
                assertEquals(HOME_LAT, rows.getDouble("lat"), 0.0)
                assertEquals(HOME_LON, rows.getDouble("lon"), 0.0)
                assertEquals(12.5, rows.getDouble("accuracy_m"), 0.0)
                assertEquals("wm", rows.getString("source"))
                assertEquals(H3.sampleCells(HOME_LAT, HOME_LON).h3R7, rows.getString("h3_r7"))
                assertEquals(H3.sampleCells(HOME_LAT, HOME_LON).h3R5, rows.getString("h3_r5"))
                assertTrue(rows.next())
                assertEquals(T0 + 900, rows.getLong("ts_utc"))
            }
            // The column types SQLite stored: an integer time, real coordinates.
            statement.executeQuery("SELECT typeof(ts_utc), typeof(lat), typeof(accuracy_m) FROM location_sample LIMIT 1").use { rows ->
                rows.next()
                assertEquals(listOf("integer", "real", "real"), listOf(rows.getString(1), rows.getString(2), rows.getString(3)))
            }
        }
    }

    // ---- the purge ----

    private fun column(sql: String): List<String> = connection.createStatement().use { statement ->
        statement.executeQuery(sql).use { rows ->
            generateSequence { if (rows.next()) rows.getString(1) else null }.toList()
        }
    }

    private fun stay(startTs: Long, endTs: Long, source: String, closed: Int = 1) {
        connection.createStatement().use {
            it.execute(
                "INSERT INTO stay (start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source) " +
                    "VALUES ($startTs, $endTs, $HOME_LAT, $HOME_LON, 60, '8760145b4ffffff', 4, $closed, '$source')",
            )
        }
    }

    private fun setCursor(value: Long) {
        connection.createStatement().use {
            it.execute("INSERT OR REPLACE INTO kv (k, v) VALUES ('stay_derivation.last_sample_id', '$value')")
        }
    }

    private val day = 86_400L
    private val cutoff get() = T0 - StoreContract.RETENTION_SEC

    @Test
    fun `the purge deletes fixes and stays past retention and nothing inside it`() {
        for (ts in listOf(cutoff - 10 * day, cutoff - 1, cutoff, cutoff + 1, T0)) StoreRules.insert(db, sample(ts))
        stay(cutoff - 5 * day, cutoff - 4 * day, "derived")
        stay(cutoff - 2 * day, cutoff - 1, "visit")
        stay(cutoff - 3600, cutoff + 3600, "derived")
        stay(cutoff - 7200, cutoff, "visit")
        stay(T0 - day, T0, "derived", closed = 0)
        setCursor(5)

        assertEquals(PurgeCounts(samples = 2, stays = 2, staysTrimmed = 2), StorePurge.run(db, T0))

        assertEquals(listOf(cutoff, cutoff + 1, T0).map { it.toString() }, column("SELECT ts_utc FROM location_sample ORDER BY ts_utc"))
        // A stay still running across the cutoff keeps its row, from the cutoff on.
        assertEquals(
            listOf("$cutoff|${cutoff + 3600}|derived", "$cutoff|$cutoff|visit", "${T0 - day}|$T0|derived"),
            column("SELECT start_ts || '|' || end_ts || '|' || source FROM stay ORDER BY id"),
        )
        // The newest fix is still there, so the cursor has nothing to catch up with.
        assertEquals(listOf("5"), column("SELECT v FROM kv"))

        // Nothing is remembered between runs: a second one finds nothing left to delete.
        assertEquals(PurgeCounts(0, 0, 0), StorePurge.run(db, T0))
    }

    @Test
    fun `when every fix is past retention the derivation cursor is pulled back with them`() {
        for (ts in listOf(cutoff - 3 * day, cutoff - 2 * day, cutoff - day)) StoreRules.insert(db, sample(ts))
        setCursor(3)

        assertEquals(PurgeCounts(samples = 3, stays = 0, staysTrimmed = 0), StorePurge.run(db, T0))
        // The next fix takes id 1 again. A cursor left at 3 would have stay derivation skip it.
        assertEquals(listOf("0"), column("SELECT v FROM kv"))
        StoreRules.insert(db, sample(T0))
        assertEquals(listOf("1"), column("SELECT id FROM location_sample"))
    }

    @Test
    fun `the purge touches no other table`() {
        connection.createStatement().use {
            it.execute(
                "INSERT INTO report_cache (query_id, payload_json, version, received_at, expires_at, revision) " +
                    "VALUES ('q', '{}', 1, 1, 2, 1)",
            )
            it.execute("INSERT INTO kv (k, v) VALUES ('purge.last_vacuum_at', '99')")
        }
        StoreRules.insert(db, sample(cutoff - day))

        StorePurge.run(db, T0)

        assertEquals(listOf("1"), column("SELECT count(*) FROM report_cache"))
        assertEquals(listOf("99"), column("SELECT v FROM kv"))
    }

    @Test
    fun `a purge that fails part-way deletes nothing`() {
        StoreRules.insert(db, sample(cutoff - day))
        stay(cutoff - 2 * day, cutoff - day, "derived")
        // The stay table goes missing between the first statement and the second.
        connection.createStatement().use { it.execute("ALTER TABLE stay RENAME TO stay_moved") }

        assertThrows(java.sql.SQLException::class.java) { StorePurge.run(db, T0) }

        assertEquals(listOf("1"), column("SELECT count(*) FROM location_sample"))
        assertEquals(listOf("1"), column("SELECT count(*) FROM stay_moved"))
    }

    @Test
    fun `a clock that has not been set deletes nothing`() {
        StoreRules.insert(db, sample(T0))
        // 1970: the cutoff is before every row there is.
        assertEquals(PurgeCounts(0, 0, 0), StorePurge.run(db, 0))
        assertEquals(listOf("1"), column("SELECT count(*) FROM location_sample"))
    }

    // ---- the checks ----

    private fun playSqlCipher() {
        db.pragmas["cipher_version"] = "4.19.0 community"
        for ((pragma, expected) in CipherPragmas.READ_BACK) db.pragmas[pragma] = expected
        db.pragmas["journal_mode"] = "wal"
    }

    @Test
    fun `a store with the pinned parameters at the expected version passes`() {
        playSqlCipher()
        StoreRules.verify(db)
    }

    @Test
    fun `a store at another schema version is refused, and nothing is written to it`() {
        playSqlCipher()
        connection.createStatement().use { it.execute("PRAGMA user_version = 2") }
        val error = assertThrows(StoreOpenException::class.java) { StoreRules.verify(db) }
        assertEquals("SCHEMA_VERSION", error.step)
        assertTrue(error.message!!.contains("version 2"))

        // An unmigrated store (a fresh file TypeScript has not opened yet) is refused the same way.
        connection.createStatement().use { it.execute("PRAGMA user_version = 0") }
        assertEquals("SCHEMA_VERSION", assertThrows(StoreOpenException::class.java) { StoreRules.verify(db) }.step)
    }

    @Test
    fun `plain SQLite is not accepted in place of SQLCipher`() {
        val error = assertThrows(StoreOpenException::class.java) { StoreRules.verify(db) }
        assertEquals("NOT_SQLCIPHER", error.step)
    }

    @Test
    fun `a drifted cipher parameter is caught by reading it back`() {
        // With a raw key SQLCipher opens the file whatever kdf_iter says: only the read-back notices.
        for ((pragma, _) in CipherPragmas.READ_BACK) {
            playSqlCipher()
            db.pragmas[pragma] = "64000"
            val error = assertThrows(pragma, StoreOpenException::class.java) { StoreRules.verify(db) }
            assertEquals("PARAM_MISMATCH", error.step)
            assertTrue(error.message!!.contains(pragma))
        }
        playSqlCipher()
        db.pragmas["journal_mode"] = "delete"
        assertEquals("PARAM_MISMATCH", assertThrows(StoreOpenException::class.java) { StoreRules.verify(db) }.step)
        playSqlCipher()
        db.pragmas["cipher_version"] = "3.4.2"
        assertEquals("NOT_SQLCIPHER", assertThrows(StoreOpenException::class.java) { StoreRules.verify(db) }.step)
    }
}
