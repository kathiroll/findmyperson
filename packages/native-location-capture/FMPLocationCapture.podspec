require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# The iOS half of @findmyperson/native-location-capture. React Native's autolinking finds this
# file in the package root; ios/README.md describes what is in ios/.
#
# NOT YET BUILT: there is no app/ios project to run `pod install` in. Everything this file
# points at has been compiled for iOS file by file (ios/scripts/check-ios.sh); this file itself
# has not been evaluated by CocoaPods. See "Not verified" in ios/README.md.
Pod::Spec.new do |s|
  s.name = "FMPLocationCapture"
  s.version = package["version"]
  s.summary = "Background location capture for findmyperson: the iOS Turbo Native Module."
  s.homepage = "https://github.com/kathiroll/findmyperson"
  s.license = "MIT"
  s.authors = "findmyperson contributors"
  s.source = { :git => "https://github.com/kathiroll/findmyperson.git", :tag => s.version.to_s }

  s.platforms = { :ios => min_ios_version_supported }
  s.swift_version = "5.9"

  # CaptureCore (the state machine), Platform (Core Location, UIKit, Keychain), Bridge (the
  # Turbo Module shim), the vendored H3 C library, and the SQLite declarations. Package.swift
  # and Tests/ are for `swift test` only and are not part of the pod.
  s.source_files = "ios/Sources/**/*.{swift,h,m,mm,c}"

  # The two C headers Swift needs. Public headers go into the pod's umbrella header, which is
  # how Swift code in a pod sees C; the Swift files import nothing for them (#if SWIFT_PACKAGE).
  s.public_header_files = [
    "ios/Sources/CH3/include/h3api.h",
    "ios/Sources/FMPSQLite/include/fmp_sqlite.h",
  ]
  # H3's internals, and the Turbo Module header: it is Objective-C++ and must stay out of the
  # umbrella header, which Swift parses as C.
  s.project_header_files = [
    "ios/Sources/CH3/h3lib/include/*.h",
    "ios/Sources/Bridge/*.h",
  ]

  s.frameworks = "CoreLocation", "UIKit", "Security"
  s.pod_target_xcconfig = {
    # A Swift pod built as a static library needs a module to import its own C headers.
    "DEFINES_MODULE" => "YES",
  }

  # The store is SQLCipher, and the only SQLCipher in the app is the one op-sqlite compiles in
  # when the app's package.json has "op-sqlite": { "sqlcipher": true }. This pod declares the
  # SQLite C functions it calls (fmp_sqlite.h) and links against that copy, so the native writer
  # and the JavaScript reader use one engine. It must not link the system libsqlite3; if it ever
  # does, the module refuses to write (the cipher_version check in SQLiteCaptureStore.swift).
  s.dependency "op-sqlite"

  # React Native core and the code generated from src/specs (codegenConfig in package.json).
  install_modules_dependencies(s)
end
