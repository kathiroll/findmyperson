#include "fmp_sqlite.h"

int sqlite3_bind_text(sqlite3_stmt *stmt, int index, const char *text, int nByte,
                      void (*destructor)(void *));

int fmp_sqlite3_bind_text_copy(sqlite3_stmt *stmt, int index, const char *text) {
  /* (void(*)(void*))-1 is SQLITE_TRANSIENT. */
  return sqlite3_bind_text(stmt, index, text, -1, (void (*)(void *))-1);
}
