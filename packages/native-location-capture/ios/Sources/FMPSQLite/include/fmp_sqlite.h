/*
 * The part of the SQLite C API the capture module calls, declared here instead of taken from a
 * sqlite3.h.
 *
 * Why not a header: the module must run on SQLCipher, and in the app the only SQLCipher is the
 * one the op-sqlite pod compiles in (the engine the TypeScript side reads the store with).
 * Importing the SDK's SQLite3 module would also auto-link the system libsqlite3, which cannot
 * open the store. These declarations link against whatever defines the symbols:
 *
 *   in the app          op-sqlite's SQLCipher (FMPLocationCapture.podspec depends on op-sqlite)
 *   in `swift test`     the system libsqlite3 (Package.swift), which is not SQLCipher
 *
 * The module never assumes it got SQLCipher: SQLiteCaptureStore reads `PRAGMA cipher_version`
 * on every open and reports the store unusable if the engine does not answer.
 *
 * Every signature below is from the public, ABI-stable SQLite C interface.
 */
#ifndef FMP_SQLITE_H
#define FMP_SQLITE_H

typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
typedef long long fmp_sqlite3_int64;

#define FMP_SQLITE_OK 0
#define FMP_SQLITE_ROW 100
#define FMP_SQLITE_DONE 101
#define FMP_SQLITE_OPEN_READWRITE 0x00000002
#define FMP_SQLITE_OPEN_FULLMUTEX 0x00010000

int sqlite3_open_v2(const char *filename, sqlite3 **ppDb, int flags, const char *zVfs);
int sqlite3_close_v2(sqlite3 *db);
int sqlite3_busy_timeout(sqlite3 *db, int ms);
const char *sqlite3_errmsg(sqlite3 *db);
int sqlite3_changes(sqlite3 *db);

int sqlite3_prepare_v2(sqlite3 *db, const char *zSql, int nByte, sqlite3_stmt **ppStmt,
                       const char **pzTail);
int sqlite3_step(sqlite3_stmt *stmt);
int sqlite3_finalize(sqlite3_stmt *stmt);
const unsigned char *sqlite3_column_text(sqlite3_stmt *stmt, int iCol);

int sqlite3_bind_int64(sqlite3_stmt *stmt, int index, fmp_sqlite3_int64 value);
int sqlite3_bind_double(sqlite3_stmt *stmt, int index, double value);

/*
 * sqlite3_bind_text with the SQLITE_TRANSIENT destructor, so SQLite copies the string before
 * this returns. Swift cannot spell the (void(*)(void*))-1 sentinel, hence the wrapper.
 */
int fmp_sqlite3_bind_text_copy(sqlite3_stmt *stmt, int index, const char *text);

#endif
