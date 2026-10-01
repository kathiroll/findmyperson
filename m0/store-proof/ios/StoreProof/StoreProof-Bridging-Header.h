// Exposes SQLCipher's C API to Swift. The header comes from the op-sqlite package
// (node_modules/@op-engineering/op-sqlite/cpp/sqlcipher, see HEADER_SEARCH_PATHS in the Xcode
// project), i.e. the very SQLCipher the OPSQLite pod compiles into the app, so the Swift writer
// binds to the same engine and version as the JS reader and never to the system libsqlite3.
// sqlite3_key_v2 is only declared when SQLITE_HAS_CODEC is defined, hence the define.
#define SQLITE_HAS_CODEC 1
#include "sqlite3.h"
