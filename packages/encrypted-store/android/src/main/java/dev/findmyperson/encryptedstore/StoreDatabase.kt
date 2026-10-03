package dev.findmyperson.encryptedstore

import java.io.File

/**
 * The few things the store needs from an open SQLCipher connection. The real one is
 * [SqlcipherDatabase]; unit tests use a fake, because SQLCipher for Android is a native
 * library that cannot be loaded on a plain JVM.
 */
interface StoreDatabase {
    /** First column of the first row as text, or null if there is no row or the value is NULL. */
    fun scalar(sql: String, args: List<Any> = emptyList()): String?

    /** Runs an INSERT and returns the new row id. */
    fun insert(sql: String, args: List<Any>): Long

    /** Runs an UPDATE and returns how many rows it changed. */
    fun update(sql: String, args: List<Any>): Int

    fun close()
}

/** Opens the file with the key set and the pinned cipher pragmas applied, creating it if absent. */
fun interface StoreDatabaseOpener {
    fun open(file: File, keyHex: String): StoreDatabase
}
