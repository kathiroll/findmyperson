package dev.findmyperson.locationcapture

import dev.findmyperson.locationcapture.Contracts.objects
import dev.findmyperson.locationcapture.Contracts.strings
import dev.findmyperson.locationcapture.core.Accuracy
import dev.findmyperson.locationcapture.core.CaptureEngine
import dev.findmyperson.locationcapture.core.CaptureMode
import dev.findmyperson.locationcapture.core.CaptureTier
import dev.findmyperson.locationcapture.core.DiagnosticEvents
import dev.findmyperson.locationcapture.core.ErrorCode
import dev.findmyperson.locationcapture.core.HealthFlag
import dev.findmyperson.locationcapture.core.PermissionState
import dev.findmyperson.locationcapture.core.PermissionStep
import dev.findmyperson.locationcapture.core.SettingsTarget
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The strings this module puts on the wire, against the generated description of the spec
 * (contracts/schema.json) and the TypeScript constants. That the Kotlin class implements every
 * method is checked by the compiler: it extends the generated NativeLocationCaptureSpec.
 */
class SpecConformanceTest {
    private val module: JSONObject = Contracts.json(Contracts.module("schema.json"))
        .getJSONObject("modules").getJSONObject("NativeLocationCapture")

    private fun unionOf(type: JSONObject): List<String> =
        type.getJSONArray("types").objects().map { it.getString("value") }

    private fun fieldType(alias: String, field: String): JSONObject =
        module.getJSONObject("aliasMap").getJSONObject(alias).getJSONArray("properties").objects()
            .single { it.getString("name") == field }.getJSONObject("typeAnnotation")

    private fun parameterType(method: String): JSONObject =
        module.getJSONObject("spec").getJSONArray("methods").objects().single { it.getString("name") == method }
            .getJSONObject("typeAnnotation").getJSONArray("params").getJSONObject(0).getJSONObject("typeAnnotation")

    @Test
    fun `modes and tiers are the spec's, minus the iOS ones`() {
        assertEquals(
            unionOf(fieldType("CaptureStatus", "mode")) - "ios",
            CaptureMode.entries.map { it.wire } + CaptureMode.STOPPED,
        )
        assertEquals(
            (unionOf(fieldType("CaptureStatus", "tier")) - "background_updates").toSet(),
            CaptureTier.entries.map { it.wire }.toSet(),
        )
    }

    @Test
    fun `permission states, steps, settings targets and accuracies are exactly the spec's`() {
        assertEquals(unionOf(fieldType("CaptureStatus", "permission")), PermissionState.entries.map { it.wire })
        assertEquals(unionOf(parameterType("requestPermission")), PermissionStep.entries.map { it.wire })
        assertEquals(unionOf(parameterType("openSystemSettings")), SettingsTarget.entries.map { it.wire })
        assertEquals(unionOf(fieldType("CaptureConfig", "accuracy")), Accuracy.entries.map { it.wire })
    }

    @Test
    fun `health flags are the spec's Android flags, in the spec's order`() {
        val all = unionOf(fieldType("CaptureStatus", "health").getJSONObject("elementType"))
        val constants = Contracts.moduleSource("src/constants.ts").readText()
        // HEALTH_FLAG_PLATFORMS: `flag: ['android', 'ios'],`
        val android = Regex("""(\w+): \[([^\]]*)],""").findAll(constants)
            .filter { it.groupValues[1] in all && it.groupValues[2].contains("'android'") }
            .map { it.groupValues[1] }
            .toList()
        assertEquals(8, android.size)
        assertEquals(android, HealthFlag.entries.map { it.wire })
        assertEquals(all.filter { it in android }, HealthFlag.entries.map { it.wire })
    }

    @Test
    fun `error codes and shared diagnostic event names are the TypeScript constants`() {
        val constants = Contracts.moduleSource("src/constants.ts").readText()
        val codes = Regex("""CAPTURE_ERROR_CODES = \[([^\]]*)]""").find(constants)!!.groupValues[1]
        assertEquals(
            Regex("'(\\w+)'").findAll(codes).map { it.groupValues[1] }.toList(),
            ErrorCode.entries.map { it.wire },
        )
        val events = Regex("""DIAGNOSTIC_EVENTS = \{(.*?)} as const""", RegexOption.DOT_MATCHES_ALL)
            .find(constants)!!.groupValues[1]
        assertEquals(
            Regex(""": '(\w+)',""").findAll(events).map { it.groupValues[1] }.toList(),
            listOf(
                DiagnosticEvents.MODE_CHANGED,
                DiagnosticEvents.CAPTURE_STARTED,
                DiagnosticEvents.CAPTURE_STOPPED,
                DiagnosticEvents.START_FAILED,
                DiagnosticEvents.STORE_UNUSABLE,
            ),
        )
    }

    @Test
    fun `sample sources are values the store contract allows`() {
        val allowed = Contracts.json(Contracts.shared("native-writer.json")).getJSONArray("sampleSources").strings()
        for (source in listOf(CaptureEngine.SOURCE_WM, CaptureEngine.SOURCE_FGS, CaptureEngine.SOURCE_MANUAL)) {
            assertTrue(source, source in allowed)
        }
        assertEquals(CaptureMode.WM.wire, CaptureEngine.SOURCE_WM)
        assertEquals(CaptureMode.FGS.wire, CaptureEngine.SOURCE_FGS)
    }
}
