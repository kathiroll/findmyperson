import XCTest

@testable import CaptureCore

/// `requestPermission`: one step at a time, and every case in which the spec says it resolves
/// with the unchanged state and shows nothing.
final class PermissionTests: XCTestCase {
    private func ask(_ phone: Harness, _ step: PermissionStep) -> () -> [PermissionState] {
        var answers: [PermissionState] = []
        phone.engine.requestPermission(step) { answers.append($0) }
        return { answers }
    }

    // MARK: foreground

    func testForegroundShowsThePromptAndResolvesWithTheAnswer() {
        let phone = Harness(authorization: .notDetermined)
        let answers = ask(phone, .foreground)

        XCTAssertEqual(phone.location.calls, ["requestWhenInUse"])
        XCTAssertEqual(answers(), [], "not resolved until the user answers")

        phone.location.setAuthorization(.whenInUse)

        XCTAssertEqual(answers(), [.foregroundOnly])
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(2)), ["perm_fg_prompt_shown", "perm_fg_granted"])
        XCTAssertEqual(phone.listener.statuses.last?.permission, .foregroundOnly)
    }

    func testForegroundDeniedResolvesDenied() {
        let phone = Harness(authorization: .notDetermined)
        let answers = ask(phone, .foreground)
        phone.location.setAuthorization(.denied)

        XCTAssertEqual(answers(), [.denied])
        XCTAssertEqual(phone.diagnostics.lines.last, "perm_fg_denied")
    }

    func testTwoCallsShowOnePromptAndBothResolve() {
        let phone = Harness(authorization: .notDetermined)
        let first = ask(phone, .foreground)
        let second = ask(phone, .foreground)
        phone.location.setAuthorization(.whenInUse)

        XCTAssertEqual(phone.location.calls, ["requestWhenInUse"])
        XCTAssertEqual(first(), [.foregroundOnly])
        XCTAssertEqual(second(), [.foregroundOnly])
    }

    func testForegroundShowsNothingOnceAnswered() {
        for authorization in [LocationAuthorization.whenInUse, .always, .denied, .restricted] {
            let phone = Harness(authorization: authorization)
            let answers = ask(phone, .foreground)
            XCTAssertEqual(answers(), [authorization.permission])
            XCTAssertEqual(phone.location.calls, [])
        }
    }

    // MARK: background

    func testBackgroundShowsTheAlwaysPromptAndResolvesWhenGranted() {
        let phone = Harness(authorization: .whenInUse)
        let answers = ask(phone, .background)

        XCTAssertEqual(phone.location.calls, ["requestAlways"])
        XCTAssertEqual(answers(), [])

        phone.engine.appWillResignActive()
        phone.location.setAuthorization(.always)

        XCTAssertEqual(answers(), [.always])
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(2)),
            ["perm_always_prompt_shown", "perm_always_granted"])

        // The timers that were waiting find nothing left to do.
        phone.engine.appDidBecomeActive()
        phone.scheduler.fire()
        XCTAssertEqual(answers(), [.always])
    }

    func testKeepOnlyWhileUsingIsInferredWhenTheAppIsActiveAgain() {
        let phone = Harness(authorization: .whenInUse)
        let answers = ask(phone, .background)

        // The prompt takes the app inactive; the user refuses; iOS sends no callback.
        phone.engine.appWillResignActive()
        phone.engine.appDidBecomeActive()
        XCTAssertEqual(answers(), [], "a grant could still arrive a moment after the app is active")
        phone.scheduler.fire()

        XCTAssertEqual(answers(), [.foregroundOnly])
        XCTAssertEqual(phone.diagnostics.lines.last, "perm_always_denied")
    }

    func testAGrantThatArrivesJustAfterTheAppIsActiveIsNotReportedAsARefusal() {
        let phone = Harness(authorization: .whenInUse)
        let answers = ask(phone, .background)
        phone.engine.appWillResignActive()
        phone.engine.appDidBecomeActive()
        phone.location.setAuthorization(.always)
        phone.scheduler.fire()

        XCTAssertEqual(answers(), [.always])
        XCTAssertFalse(phone.diagnostics.lines.contains("perm_always_denied"))
    }

    func testIosShowsTheAlwaysPromptOnceSoTheSecondRequestShowsNothing() {
        let phone = Harness(authorization: .whenInUse)
        _ = ask(phone, .background)
        phone.engine.appWillResignActive()
        phone.engine.appDidBecomeActive()
        phone.scheduler.fire()
        phone.location.clearCalls()

        let again = ask(phone, .background)

        XCTAssertEqual(again(), [.foregroundOnly])
        XCTAssertEqual(phone.location.calls, [])

        // Also after the app was killed: the fact is stored.
        phone.kill()
        phone.launch()
        let afterRelaunch = ask(phone, .background)
        XCTAssertEqual(afterRelaunch(), [.foregroundOnly])
        XCTAssertEqual(phone.location.calls, [])
    }

    func testIfIosShowsNoPromptTheRequestStillResolvesAndThePromptIsNotSpent() {
        let phone = Harness(authorization: .whenInUse)
        let answers = ask(phone, .background)
        XCTAssertEqual(phone.scheduler.pendingDelays, [3])

        // The app never went inactive: nothing was shown.
        phone.scheduler.fire()

        XCTAssertEqual(answers(), [.foregroundOnly])
        XCTAssertEqual(phone.stateStorage.saved?.alwaysPromptShown, false)
        phone.location.clearCalls()
        _ = ask(phone, .background)
        XCTAssertEqual(phone.location.calls, ["requestAlways"])
    }

    func testBackgroundShowsNothingBeforeForegroundIsGrantedOrWhenIosWillNotAsk() {
        for authorization in [LocationAuthorization.notDetermined, .denied, .restricted, .always] {
            let phone = Harness(authorization: authorization)
            let answers = ask(phone, .background)
            XCTAssertEqual(answers(), [authorization.permission])
            XCTAssertEqual(phone.location.calls, [])
        }
    }

    func testGrantingAlwaysWhileCapturingAddsTheRelaunchSources() throws {
        let phone = Harness(authorization: .whenInUse)
        try phone.start()
        XCTAssertFalse(phone.location.canRelaunchApp)

        _ = ask(phone, .background)
        phone.location.setAuthorization(.always)

        XCTAssertTrue(phone.location.canRelaunchApp)
        XCTAssertEqual(phone.status.tier, .backgroundUpdates)
    }
}
