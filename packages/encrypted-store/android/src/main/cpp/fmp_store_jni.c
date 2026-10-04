// The JNI front for the SQLCipher functions the Kotlin store uses: the Android counterpart of
// ios/FMPSqlcipher.c.
//
// Why it exists: the Kotlin writer must use the SQLCipher that op-sqlite compiles into
// libop-sqlite.so, the copy the JavaScript side reads and writes through. SQLite's file locks
// belong to the process, so two copies of the library in one process do not see each other's
// locks; one copy keeps its own record of who holds what, and every connection made through it
// is covered. This file therefore contains no SQLite: sqlite3.h comes from op-sqlite's
// cpp/sqlcipher directory, and every sqlite3_* symbol below is left undefined here and bound
// to libop-sqlite.so when the library loads (CMakeLists.txt).
//
// Text crosses as UTF-8 byte arrays, never as jstring: JNI strings are "modified UTF-8", which
// is not what SQLite reads. Every function returns the SQLite result code unchanged, and a
// handle is the pointer as a jlong. SqlcipherConnection.kt is the only caller.
#define _GNU_SOURCE // dladdr on glibc, for the host build the unit tests run against

// sqlite3_key_v2 is only declared when SQLITE_HAS_CODEC is defined.
#ifndef SQLITE_HAS_CODEC
#define SQLITE_HAS_CODEC 1
#endif
#include "sqlite3.h"

#include <dlfcn.h>
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

_Static_assert(SQLITE_OK == 0, "Kotlin compares against 0 for SQLITE_OK");
_Static_assert(SQLITE_ROW == 100, "Kotlin compares against 100 for SQLITE_ROW");
_Static_assert(SQLITE_DONE == 101, "Kotlin compares against 101 for SQLITE_DONE");
_Static_assert(sizeof(void *) <= sizeof(jlong), "a handle is a pointer carried in a jlong");

#define FMP_JNI(type, name) \
  JNIEXPORT type JNICALL Java_dev_findmyperson_encryptedstore_SqlcipherNative_##name

static sqlite3 *as_db(jlong handle) { return (sqlite3 *)(intptr_t)handle; }
static sqlite3_stmt *as_stmt(jlong handle) { return (sqlite3_stmt *)(intptr_t)handle; }

// A NUL-terminated copy of a byte array, to be released with free(). NULL when out of memory.
static char *copy_bytes(JNIEnv *env, jbyteArray bytes, jsize *length) {
  jsize count = (*env)->GetArrayLength(env, bytes);
  char *copy = malloc((size_t)count + 1);
  if (copy == NULL) {
    return NULL;
  }
  (*env)->GetByteArrayRegion(env, bytes, 0, count, (jbyte *)copy);
  copy[count] = 0;
  if (length != NULL) {
    *length = count;
  }
  return copy;
}

static jbyteArray to_bytes(JNIEnv *env, const char *text, jsize count) {
  if (text == NULL) {
    return NULL;
  }
  jbyteArray bytes = (*env)->NewByteArray(env, count);
  if (bytes != NULL) {
    (*env)->SetByteArrayRegion(env, bytes, 0, count, (const jbyte *)text);
  }
  return bytes;
}

static void store_handle(JNIEnv *env, jlongArray out, void *pointer) {
  jlong handle = (jlong)(intptr_t)pointer;
  (*env)->SetLongArrayRegion(env, out, 0, 1, &handle);
}

// Opens read-write in serialized threading mode, creating the file only if `create`. SQLite
// hands back a connection even when the open failed, so that the caller can read the message;
// out[0] must be closed whatever the result code.
FMP_JNI(jint, open)(JNIEnv *env, jclass type, jbyteArray path, jboolean create, jlongArray out) {
  (void)type;
  char *file = copy_bytes(env, path, NULL);
  if (file == NULL) {
    return SQLITE_NOMEM;
  }
  sqlite3 *db = NULL;
  int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | (create ? SQLITE_OPEN_CREATE : 0);
  int rc = sqlite3_open_v2(file, &db, flags, NULL);
  free(file);
  store_handle(env, out, db);
  return rc;
}

// Sets the SQLCipher key of the main database. Must be the first call after open.
FMP_JNI(jint, key)(JNIEnv *env, jclass type, jlong db, jbyteArray key) {
  (void)type;
  jsize length = 0;
  char *copy = copy_bytes(env, key, &length);
  if (copy == NULL) {
    return SQLITE_NOMEM;
  }
  int rc = sqlite3_key_v2(as_db(db), "main", copy, (int)length);
  // The key must not outlive the call in freed memory. A volatile pointer keeps the compiler
  // from dropping the wipe as a dead store.
  volatile char *wipe = copy;
  for (jsize i = 0; i < length; i++) {
    wipe[i] = 0;
  }
  free(copy);
  return rc;
}

FMP_JNI(jint, busyTimeout)(JNIEnv *env, jclass type, jlong db, jint milliseconds) {
  (void)env;
  (void)type;
  return sqlite3_busy_timeout(as_db(db), milliseconds);
}

FMP_JNI(jint, close)(JNIEnv *env, jclass type, jlong db) {
  (void)env;
  (void)type;
  return sqlite3_close_v2(as_db(db));
}

FMP_JNI(jbyteArray, errmsg)(JNIEnv *env, jclass type, jlong db) {
  (void)type;
  const char *message = sqlite3_errmsg(as_db(db));
  return to_bytes(env, message, message == NULL ? 0 : (jsize)strlen(message));
}

FMP_JNI(jint, changes)(JNIEnv *env, jclass type, jlong db) {
  (void)env;
  (void)type;
  return sqlite3_changes(as_db(db));
}

FMP_JNI(jlong, lastInsertRowid)(JNIEnv *env, jclass type, jlong db) {
  (void)env;
  (void)type;
  return sqlite3_last_insert_rowid(as_db(db));
}

FMP_JNI(jint, prepare)(JNIEnv *env, jclass type, jlong db, jbyteArray sql, jlongArray out) {
  (void)type;
  jsize length = 0;
  char *text = copy_bytes(env, sql, &length);
  if (text == NULL) {
    return SQLITE_NOMEM;
  }
  sqlite3_stmt *statement = NULL;
  int rc = sqlite3_prepare_v2(as_db(db), text, (int)length, &statement, NULL);
  free(text);
  store_handle(env, out, statement);
  return rc;
}

// Parameter indexes start at 1.
FMP_JNI(jint, bindLong)(JNIEnv *env, jclass type, jlong statement, jint index, jlong value) {
  (void)env;
  (void)type;
  return sqlite3_bind_int64(as_stmt(statement), index, value);
}

FMP_JNI(jint, bindDouble)(JNIEnv *env, jclass type, jlong statement, jint index, jdouble value) {
  (void)env;
  (void)type;
  return sqlite3_bind_double(as_stmt(statement), index, value);
}

// SQLite copies the text (SQLITE_TRANSIENT), so the buffer is released before returning.
FMP_JNI(jint, bindText)(JNIEnv *env, jclass type, jlong statement, jint index, jbyteArray value) {
  (void)type;
  jsize length = 0;
  char *text = copy_bytes(env, value, &length);
  if (text == NULL) {
    return SQLITE_NOMEM;
  }
  int rc = sqlite3_bind_text(as_stmt(statement), index, text, (int)length, SQLITE_TRANSIENT);
  free(text);
  return rc;
}

FMP_JNI(jint, bindNull)(JNIEnv *env, jclass type, jlong statement, jint index) {
  (void)env;
  (void)type;
  return sqlite3_bind_null(as_stmt(statement), index);
}

FMP_JNI(jint, step)(JNIEnv *env, jclass type, jlong statement) {
  (void)env;
  (void)type;
  return sqlite3_step(as_stmt(statement));
}

// Column indexes start at 0. NULL for an SQL NULL.
FMP_JNI(jbyteArray, columnText)(JNIEnv *env, jclass type, jlong statement, jint column) {
  (void)type;
  const unsigned char *text = sqlite3_column_text(as_stmt(statement), column);
  return to_bytes(env, (const char *)text, sqlite3_column_bytes(as_stmt(statement), column));
}

FMP_JNI(jint, finalizeStatement)(JNIEnv *env, jclass type, jlong statement) {
  (void)env;
  (void)type;
  return sqlite3_finalize(as_stmt(statement));
}

// The file of the library that sqlite3_open_v2 was bound to when this one loaded, as the
// dynamic linker reports it, or NULL if it cannot say. On a phone that must be libop-sqlite.so;
// SqlcipherConnection refuses to open anything if it is not.
FMP_JNI(jbyteArray, engineLibrary)(JNIEnv *env, jclass type) {
  (void)type;
  Dl_info info;
  if (dladdr((void *)(uintptr_t)&sqlite3_open_v2, &info) == 0 || info.dli_fname == NULL) {
    return NULL;
  }
  return to_bytes(env, info.dli_fname, (jsize)strlen(info.dli_fname));
}
