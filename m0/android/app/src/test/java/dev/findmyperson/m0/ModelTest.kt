package dev.findmyperson.m0

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelTest {
    @Test
    fun permissionColumnMapping() {
        assertEquals("denied", PermissionColumn.of(false, false, false))
        assertEquals("denied", PermissionColumn.of(false, false, true))
        assertEquals("foreground", PermissionColumn.of(true, true, false))
        assertEquals("foreground", PermissionColumn.of(true, false, false))
        assertEquals("background", PermissionColumn.of(true, true, true))
        assertEquals("foreground_approx", PermissionColumn.of(false, true, false))
        assertEquals("background_approx", PermissionColumn.of(false, true, true))
    }

    @Test
    fun modeColumnValues() {
        assertEquals("wm", Mode.WM.column)
        assertEquals("fgs", Mode.FGS.column)
    }

    @Test
    fun modePrefRoundTrip() {
        assertEquals(Mode.WM, Mode.fromPref(Mode.toPref(Mode.WM)))
        assertEquals(Mode.FGS, Mode.fromPref(Mode.toPref(Mode.FGS)))
        assertNull(Mode.fromPref(Mode.toPref(null)))
        assertNull(Mode.fromPref("garbage"))
        assertNull(Mode.fromPref(null))
        assertEquals("stopped", Mode.toPref(null))
    }

    @Test
    fun brandDetection() {
        assertEquals(Brand.XIAOMI, BrandDetector.detect("Xiaomi"))
        assertEquals(Brand.XIAOMI, BrandDetector.detect("POCO"))
        assertEquals(Brand.ONEPLUS, BrandDetector.detect("OnePlus"))
        assertEquals(Brand.SAMSUNG, BrandDetector.detect("samsung"))
        assertEquals(Brand.OTHER, BrandDetector.detect("Google"))
        assertEquals(Brand.OTHER, BrandDetector.detect(null))
    }

    private fun state(
        fg: Boolean = true, bg: Boolean = true, bgSettings: Boolean = true,
        notif: Boolean = true, notifReq: Boolean = false,
        hib: Boolean = true, batt: Boolean = true, skipped: Set<Step> = emptySet(),
    ) = SetupState(fg, bg, bgSettings, notif, notifReq, hib, batt, skipped)

    @Test
    fun setupFlowOrder() {
        assertEquals(Step.FOREGROUND, SetupFlow.nextStep(state(fg = false, bg = false, hib = false, batt = false)))
        assertEquals(Step.BACKGROUND, SetupFlow.nextStep(state(bg = false, hib = false)))
        assertEquals(Step.NOTIFICATIONS, SetupFlow.nextStep(state(notif = false, notifReq = true, hib = false)))
        assertEquals(Step.HIBERNATION, SetupFlow.nextStep(state(hib = false, batt = false)))
        assertEquals(Step.BATTERY, SetupFlow.nextStep(state(batt = false)))
        assertEquals(Step.DONE, SetupFlow.nextStep(state()))
    }

    @Test
    fun notificationStepOnlyWhenRequired() {
        assertEquals(Step.DONE, SetupFlow.nextStep(state(notif = false, notifReq = false)))
    }

    @Test
    fun backgroundStepSkippedBeforeAndroid10() {
        assertEquals(Step.DONE, SetupFlow.nextStep(state(bg = false, bgSettings = false)))
    }

    @Test
    fun skippedOptionalStepsAreNotShownAgain() {
        assertEquals(Step.DONE, SetupFlow.nextStep(state(hib = false, batt = false, skipped = setOf(Step.HIBERNATION, Step.BATTERY))))
    }
}
