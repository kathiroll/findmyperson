# WorkManager creates the workers by class name through reflection, and the names are stored in
# its database across app updates, so they must not be renamed.
-keep class dev.findmyperson.locationcapture.platform.CaptureWorker { <init>(...); }
-keep class dev.findmyperson.locationcapture.platform.WatchdogWorker { <init>(...); }
