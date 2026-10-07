require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# The iOS half of @findmyperson/native-location-capture. React Native's autolinking finds this
# file in the package root; ios/README.md describes what is in ios/.
#
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

  # CaptureCore (the state machine), Platform (Core Location, UIKit, store port adapters), Bridge (the
  # Turbo Module shim), the vendored H3 C library. Package.swift
  # and Tests/ are for `swift test` only and are not part of the pod.
  s.source_files = "ios/Sources/**/*.{swift,h,m,mm,c}"
  # Legacy opener exists only in the Foundation host test target, never in the phone app.
  s.exclude_files = ["ios/Sources/CaptureCore/SQLiteCaptureStore.swift", "ios/Sources/FMPSQLite/**/*"]

  # The H3 header Swift needs. Public headers go into the pod's umbrella header, which is
  # how Swift code in a pod sees C; the Swift files import nothing for them (#if SWIFT_PACKAGE).
  s.public_header_files = [
    "ios/Sources/CH3/include/h3api.h",
  ]
  # H3's internals, and the Turbo Module header: it is Objective-C++ and must stay out of the
  # umbrella header, which Swift parses as C.
  s.project_header_files = [
    "ios/Sources/CH3/h3lib/include/*.h",
    "ios/Sources/Bridge/*.h",
  ]

  s.frameworks = "CoreLocation", "UIKit", "Security", "Network"
  s.pod_target_xcconfig = {
    # A Swift pod built as a static library needs a module to import its own C headers.
    "DEFINES_MODULE" => "YES",
  }

  # The sole store owner links op-sqlite's SQLCipher. Capture never opens a file or imports
  # system SQLite; deleting through the vault closes the very connection this adapter writes.
  s.dependency "FindMyPersonEncryptedStore"

  # React Native core and the code generated from src/specs (codegenConfig in package.json).
  install_modules_dependencies(s)
end
