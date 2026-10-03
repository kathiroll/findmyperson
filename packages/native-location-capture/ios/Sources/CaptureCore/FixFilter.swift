import Foundation

/// The rule of `CaptureConfig`: a fix is stored when `minIntervalSec` has passed since the last
/// stored sample OR the phone is at least `minDistanceM` from it. Core Location delivers about
/// one fix a second while continuous updates run, so this is what turns that stream into the
/// 15-minute cadence, and what keeps a sample coming from a phone that is sitting still.
enum FixFilter {
    /// - Parameters:
    ///   - lastWrittenTsUtc: fix time of the sample stored most recently, nil if there is none.
    ///   - distanceFromLastM: metres from that sample. Nil in a process that has not stored one
    ///     yet: the position of the last sample is in the encrypted store, which this module
    ///     never reads, and it is not kept anywhere else.
    ///   - leftLastRegion: iOS reported that the phone left the circle around the last sample.
    ///     That circle is at least `minDistanceM` wide, so it stands in for the distance when
    ///     the distance itself is unknown.
    static func shouldStore(
        fixTsUtc: Int64,
        lastWrittenTsUtc: Int64?,
        distanceFromLastM: Double?,
        leftLastRegion: Bool,
        config: CaptureConfig
    ) -> Bool {
        guard let lastWrittenTsUtc else { return true }
        // The magnitude, so a clock that was set back cannot hold capture off until it catches
        // up with the last stored time.
        let elapsed = Double(abs(fixTsUtc - lastWrittenTsUtc))
        if elapsed >= config.minIntervalSec {
            return true
        }
        if leftLastRegion {
            return true
        }
        if let distanceFromLastM {
            return distanceFromLastM >= config.minDistanceM
        }
        return false
    }
}
