package dev.findmyperson.locationcapture

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The contract files of the repo, read from where they are committed. build.gradle passes the
 * directories in as system properties, so a test never works from a copy that could go stale.
 */
object Contracts {
    private fun directory(property: String): File =
        File(checkNotNull(System.getProperty(property)) { "$property is not set; run the tests through Gradle" })

    /** packages/shared/contracts */
    fun shared(name: String): File = File(directory("fmp.sharedContracts"), name)

    /** packages/native-location-capture/contracts */
    fun module(name: String): File = File(directory("fmp.moduleContracts"), name)

    /** A source file of packages/native-location-capture, by its path from the package root. */
    fun moduleSource(path: String): File = File(directory("fmp.moduleContracts").parentFile, path)

    fun manifest(): File = File(checkNotNull(System.getProperty("fmp.manifest")))

    fun json(file: File): JSONObject = JSONObject(file.readText(Charsets.UTF_8))

    fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
}
