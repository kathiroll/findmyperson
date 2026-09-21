import Foundation

/// Rate limit for continuous-update rows: at most one row per 15-minute wall-clock slot,
/// written at the first fix after the slot opens. Slots are aligned to UTC quarter hours
/// (epoch / 15 min), which is also aligned in every real-world time zone.
/// Why: the Android app samples every 15 minutes, so iPhone numbers are comparable only
/// if we thin the (much denser) iOS callback stream to the same cadence.
public enum SlotGate {
    public static let slotMs: Int64 = 15 * 60 * 1000

    public static func slot(forMs ms: Int64) -> Int64 {
        // floor division, also right for (unrealistic) negative values
        let q = ms / slotMs
        return (ms % slotMs != 0 && ms < 0) ? q - 1 : q
    }

    /// True if no row has been written yet in the slot containing `nowMs`.
    public static func shouldWrite(nowMs: Int64, lastWrittenSlot: Int64?) -> Bool {
        guard let last = lastWrittenSlot else { return true }
        return slot(forMs: nowMs) != last
    }
}
