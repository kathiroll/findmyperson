# findmyperson

A non-commercial, open-source app that broadcasts missing-person reports against on-device location history, so anyone who may have crossed paths with a missing person can be notified and asked for any information they have.

## The problem

Missing-person appeals today spread informally through social posts asking for tips. The odds that someone who actually saw the missing person also happens to see that specific post are low, especially without a large social reach.

## The proposed approach

Each user's device keeps a local history of recent locations. When a missing-person report is broadcast, it is checked against that history. If a user's location history overlaps the missing person's last known location and time, that user gets a notification and a way to report what they know.

This project is early and under active research and design. See open questions and findings as they land in this repository.

## Status

Pre-implementation. No app code yet.

## License

MIT, see [LICENSE](LICENSE).
