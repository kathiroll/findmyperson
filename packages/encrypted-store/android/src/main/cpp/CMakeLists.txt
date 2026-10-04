# libfmp-store-jni.so: the JNI front of the Kotlin store (fmp_store_jni.c).
#
# It is built only inside the app, where op-sqlite is a Gradle project beside this one and
# publishes libop-sqlite.so and its headers as a prefab package. The one source file is compiled
# against op-sqlite's SQLCipher header and linked against libop-sqlite.so, so the sqlite3_*
# symbols are resolved from the library the JavaScript side uses.
#
# NEVER add a SQLite or SQLCipher source file or a static SQLite library to this target: that
# would put a second copy of SQLite in the process, which is what this library exists to avoid
# (README.md, "One SQLite library in the Android process"). src/policy.test.ts and
# scripts/check-native-libs.ts fail if it happens.
cmake_minimum_required(VERSION 3.13)
project(fmp_store_jni C)

# The prefab package is named after op-sqlite's Gradle project, which React Native's autolinking
# derives from the npm name @op-engineering/op-sqlite.
find_package(op-engineering_op-sqlite REQUIRED CONFIG)

add_library(fmp-store-jni SHARED fmp_store_jni.c)

# op-sqlite publishes its whole cpp directory. The SQLCipher header is the one in sqlcipher/;
# the sqlite3.h beside it is plain SQLite and does not declare sqlite3_key_v2.
get_target_property(OP_SQLITE_INCLUDE op-engineering_op-sqlite::op-sqlite INTERFACE_INCLUDE_DIRECTORIES)
target_include_directories(fmp-store-jni PRIVATE "${OP_SQLITE_INCLUDE}/op-engineering_op-sqlite/sqlcipher")

target_compile_options(fmp-store-jni PRIVATE -Wall -Wextra -Werror)
# A symbol libop-sqlite.so does not export must fail this link, not the first open on a phone.
target_link_options(fmp-store-jni PRIVATE -Wl,--no-undefined)
target_link_libraries(fmp-store-jni PRIVATE op-engineering_op-sqlite::op-sqlite)
