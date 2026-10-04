/**
 * TABLE OWNERSHIP: which task writes which table.
 *
 * Eight later tasks read or write these tables. This list is the single statement of who owns
 * each write path, so that no two tasks both assume a write is theirs and no write is left
 * without an owner. Reading is unrestricted: any task may call any `list*` or `get*` function.
 *
 * Rules:
 *   1. A task writes only the paths listed against it, and only through the functions in
 *      store/tables/. No task runs its own INSERT, UPDATE or DELETE on these tables.
 *   2. A task that needs a write nobody owns adds the function to the table's module and a line
 *      here, in the same change.
 *   3. Only store/migrations.ts changes the schema, by appending a migration.
 *
 * Owners are named by their task in the architecture plan (data/fmp-arch-plan/report.md,
 * Part 2). ownership.test.ts checks that this list covers exactly the tables migration v1
 * creates.
 *
 * OPEN: the plan's retention section (4.7) predates `own_report` and `received_response` and
 * says nothing about how long they are kept. Until that is decided the retention purge must
 * leave both tables alone; "Delete all my data" still removes them with everything else.
 */
export const STORE_TABLES = [
  'location_sample',
  'stay',
  'report_cache',
  'match',
  'subscription',
  'outbound_response',
  'own_report',
  'received_response',
  'kv',
] as const;
export type StoreTable = (typeof STORE_TABLES)[number];

export interface WritePath {
  /** The task that owns this write. */
  owner: string;
  /** What it writes, and through which function. */
  writes: string;
}

export const TABLE_OWNERSHIP: Readonly<Record<StoreTable, readonly WritePath[]>> = {
  location_sample: [
    {
      owner: 'C2.1 Android native module, C2.2 iOS native module',
      writes:
        'insert only, natively, with INSERT_LOCATION_SAMPLE_SQL. TypeScript never writes this table outside tests',
    },
    {
      owner: 'C2.5 retention purge',
      writes:
        'delete rows past retention (deleteSamplesBefore), and natively on a capture wake with the same statement (DELETE_SAMPLES_BEFORE_SQL)',
    },
  ],
  stay: [
    {
      owner: 'C2.4 stay derivation',
      writes:
        "insert, extend, close and de-duplicate rows with source 'derived', all inside deriveStays (insertStay, updateDerivedStay, deleteDerivedStay)",
    },
    {
      owner: 'C2.2 iOS native module',
      writes:
        "insert and close rows with source 'visit', natively, with INSERT_VISIT_STAY_SQL and CLOSE_VISIT_STAY_SQL",
    },
    {
      owner: 'C2.5 retention purge',
      writes:
        'delete rows past retention, and move the start of a row still running across it up to the cutoff (deleteStaysEndedBefore, trimStaysStartedBefore), and natively on a capture wake with the same two statements, for both sources',
    },
  ],
  report_cache: [
    {
      owner: 'B3.6 bundle fetcher',
      writes:
        'insert and revise verified queries, and drop ones no longer published (upsertCachedReport, deleteCachedReport)',
    },
    { owner: 'M5.2 match runner', writes: 'the last_matched_at cursor only (setLastMatchedAt)' },
    { owner: 'C2.5 retention purge', writes: 'delete expired rows (deleteExpiredReports)' },
  ],
  match: [
    { owner: 'M5.2 match runner', writes: 'insert, in state new (insertMatchIfAbsent)' },
    {
      owner: 'M5.3 match notification and match screen',
      writes: 'state to notified, opened or dismissed (advanceMatchState)',
    },
    { owner: 'M5.4 send pipeline', writes: 'state to responded (advanceMatchState)' },
    {
      owner: 'C2.5 retention purge',
      writes: 'delete rows whose report is gone (deleteOrphanMatches)',
    },
  ],
  subscription: [
    {
      owner: 'B3.7 subscription manager',
      writes:
        'every write, as the difference between the watch set and the rows stored, inside syncSubscriptions (putSubscription, deleteSubscription)',
    },
  ],
  outbound_response: [
    {
      owner: 'M5.4 identity-choice screen',
      writes: "enqueue, once, after the user's final confirmation (enqueueResponse)",
    },
    {
      owner: 'M5.4 send queue',
      writes:
        'every state change after enqueue (markResponseSending, markResponseSent, markResponseRetry, markResponseFailed, requeueInterruptedResponses)',
    },
    {
      owner: 'C2.5 retention purge',
      writes: 'delete sent and failed rows after 7 days (deleteFinishedResponsesBefore)',
    },
  ],
  own_report: [
    { owner: 'R4.1 report submit screen', writes: 'enqueue (enqueueOwnReport)' },
    {
      owner: 'M5.4 send queue (the one queue module, shared with R4.1)',
      writes:
        'every submit-state change (markOwnReportSending, markOwnReportAcknowledged, markOwnReportRetry, markOwnReportFailed, requeueInterruptedOwnReports)',
    },
    {
      owner: 'R4.3 active report screen',
      writes: "the server's answer to an edit or an end (applyServerReport)",
    },
    { owner: 'R4.5 reporter response fetch', writes: 'responses_cursor only (setResponsesCursor)' },
  ],
  received_response: [
    { owner: 'R4.5 reporter response fetch', writes: 'insert (saveReceivedResponses)' },
    { owner: 'R4.3 active report screen', writes: 'read_at only (markResponsesRead)' },
  ],
  kv: [
    {
      owner: 'per key, as listed in store/tables/kv.ts',
      writes: 'kvSet and kvDelete on its own keys only',
    },
    {
      owner: 'C2.5 retention purge',
      writes:
        'the stay-derivation cursor only, pulled back after it deletes the newest fixes, in TypeScript and natively (REWIND_STAY_CURSOR_SQL)',
    },
  ],
};
