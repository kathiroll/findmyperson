require "json"

# The iOS half of @findmyperson/encrypted-store: the store key (Keychain), the backup-excluded
# directory, the Swift writer the capture module uses, and the Turbo Native Module for
# src/specs/NativeEncryptedStore.ts. React Native's autolinking finds this file by itself.
#
# NOT YET BUILT BY COCOAPODS. app/ios does not exist, so `pod install` has never run on this
# file. The Swift and C in ios/ are compiled and run on a Mac by ios/build-host-check.sh;
# what only a real iOS build can show is listed in README.md under "Not verified".
package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# FMPSqlcipher.c includes "sqlite3.h" from the SQLCipher source op-sqlite compiles into the
# app, so this code binds to that engine and never to the system libsqlite3. The op-sqlite pod
# supplies the symbols at link time; `"op-sqlite": {"sqlcipher": true}` in package.json is what
# makes it compile SQLCipher.
op_sqlite = File.dirname(`node --print "require.resolve('@op-engineering/op-sqlite/package.json', { paths: ['#{__dir__}'] })"`.strip)
sqlcipher_headers = File.join(op_sqlite, "cpp", "sqlcipher")

Pod::Spec.new do |s|
  s.name         = "FindMyPersonEncryptedStore"
  s.version      = package["version"]
  s.summary      = "findmyperson's encrypted on-device store: key, backup-excluded directory, native writer."
  s.homepage     = "https://github.com/kathiroll/findmyperson"
  s.license      = "MIT"
  s.authors      = "findmyperson"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :path => "." }
  s.swift_version = "5.0"

  # ios/HostCheck is the macOS test harness and is not part of the app.
  s.source_files = "ios/*.{h,c,m,mm,swift}"
  # Swift sees the C front through the module's umbrella header. The Turbo Native Module header
  # is ObjC++ and must stay out of it.
  s.public_header_files = "ios/FMPSqlcipher.h"
  s.project_header_files = "ios/RCTNativeEncryptedStore.h"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "HEADER_SEARCH_PATHS" => "\"#{sqlcipher_headers}\"",
  }
  s.frameworks = "Security"
  s.dependency "op-sqlite"

  install_modules_dependencies(s)
end
