// See FMPSqlcipher.h. sqlite3_key_v2 is only declared when SQLITE_HAS_CODEC is defined.
#ifndef SQLITE_HAS_CODEC
#define SQLITE_HAS_CODEC 1
#endif
#include "sqlite3.h"

#include "FMPSqlcipher.h"

_Static_assert(SQLITE_OK == 0, "Swift compares against 0 for SQLITE_OK");
_Static_assert(SQLITE_ROW == 100, "Swift compares against 100 for SQLITE_ROW");
_Static_assert(SQLITE_DONE == 101, "Swift compares against 101 for SQLITE_DONE");

int fmp_db_open(const char *path, fmp_db **out) {
  sqlite3 *db = 0;
  int rc = sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, 0);
  *out = (fmp_db *)db;
  return rc;
}

int fmp_db_key(fmp_db *db, const char *key, int key_length) {
  return sqlite3_key_v2((sqlite3 *)db, "main", key, key_length);
}

int fmp_db_busy_timeout(fmp_db *db, int milliseconds) {
  return sqlite3_busy_timeout((sqlite3 *)db, milliseconds);
}

int fmp_db_close(fmp_db *db) { return sqlite3_close_v2((sqlite3 *)db); }

const char *fmp_db_errmsg(fmp_db *db) { return sqlite3_errmsg((sqlite3 *)db); }

int fmp_db_changes(fmp_db *db) { return sqlite3_changes((sqlite3 *)db); }

int64_t fmp_db_last_insert_rowid(fmp_db *db) { return sqlite3_last_insert_rowid((sqlite3 *)db); }

int fmp_stmt_prepare(fmp_db *db, const char *sql, fmp_stmt **out) {
  sqlite3_stmt *stmt = 0;
  int rc = sqlite3_prepare_v2((sqlite3 *)db, sql, -1, &stmt, 0);
  *out = (fmp_stmt *)stmt;
  return rc;
}

int fmp_stmt_bind_int64(fmp_stmt *stmt, int index, int64_t value) {
  return sqlite3_bind_int64((sqlite3_stmt *)stmt, index, value);
}

int fmp_stmt_bind_double(fmp_stmt *stmt, int index, double value) {
  return sqlite3_bind_double((sqlite3_stmt *)stmt, index, value);
}

int fmp_stmt_bind_text(fmp_stmt *stmt, int index, const char *value) {
  return sqlite3_bind_text((sqlite3_stmt *)stmt, index, value, -1, SQLITE_TRANSIENT);
}

int fmp_stmt_step(fmp_stmt *stmt) { return sqlite3_step((sqlite3_stmt *)stmt); }

const unsigned char *fmp_stmt_column_text(fmp_stmt *stmt, int column) {
  return sqlite3_column_text((sqlite3_stmt *)stmt, column);
}

int fmp_stmt_finalize(fmp_stmt *stmt) { return sqlite3_finalize((sqlite3_stmt *)stmt); }
