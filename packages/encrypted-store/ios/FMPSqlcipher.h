// A small C front for the SQLCipher functions the Swift store uses.
//
// Why it exists: Swift code in a CocoaPods library cannot use a bridging header, and importing
// "sqlite3.h" into the library's module would collide with the SQLite module of the iOS SDK.
// So FMPSqlcipher.c is the only file that includes sqlite3.h, taken from op-sqlite's
// cpp/sqlcipher directory (see the podspec), and Swift sees only these opaque wrappers. The
// symbols it binds to are the SQLCipher that the op-sqlite pod compiles into the app: the same
// engine and version the JavaScript side uses, never the system libsqlite3.
//
// Every function returns the SQLite result code unchanged. FMPSqlcipher.c asserts at compile
// time that the three codes Swift compares against (0, 100, 101) are SQLITE_OK, SQLITE_ROW and
// SQLITE_DONE.
#ifndef FMPSqlcipher_h
#define FMPSqlcipher_h

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct fmp_db fmp_db;
typedef struct fmp_stmt fmp_stmt;

// Opens read-write, creating the file if absent, in serialized threading mode.
int fmp_db_open(const char *path, fmp_db **out);
// Sets the SQLCipher key of the main database. Must be the first call after open.
int fmp_db_key(fmp_db *db, const char *key, int key_length);
int fmp_db_busy_timeout(fmp_db *db, int milliseconds);
int fmp_db_close(fmp_db *db);
const char *fmp_db_errmsg(fmp_db *db);
int fmp_db_changes(fmp_db *db);
int64_t fmp_db_last_insert_rowid(fmp_db *db);

int fmp_stmt_prepare(fmp_db *db, const char *sql, fmp_stmt **out);
// Parameter indexes start at 1. Text is copied.
int fmp_stmt_bind_int64(fmp_stmt *stmt, int index, int64_t value);
int fmp_stmt_bind_double(fmp_stmt *stmt, int index, double value);
int fmp_stmt_bind_text(fmp_stmt *stmt, int index, const char *value);
int fmp_stmt_step(fmp_stmt *stmt);
// Column indexes start at 0. NULL for an SQL NULL. Valid until the next step or finalize.
const unsigned char *fmp_stmt_column_text(fmp_stmt *stmt, int column);
int fmp_stmt_finalize(fmp_stmt *stmt);

#ifdef __cplusplus
}
#endif

#endif
