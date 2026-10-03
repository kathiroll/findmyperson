/**
 * The captain's alert when a report reaches `pending`.
 *
 * STUB. There is no push, SMS or email channel yet; this only writes one clearly named log
 * event. THIS IS WHERE A REAL NOTIFICATION CHANNEL PLUGS IN: implement `OperatorAlerter` (send
 * the push, SMS or email) and pass it to `buildApp`; no other code changes. Until then, someone
 * has to watch the server log for `report.pending` or call GET /v1/operator/reports.
 *
 * The event carries the reporter's phone because the operator's next step is to call it.
 */
export interface PendingReportAlert {
  query_id: string;
  reporter_phone: string;
  created_at: number;
}

export interface OperatorAlerter {
  reportPending(alert: PendingReportAlert): void | Promise<void>;
}

export interface AlertLog {
  warn(object: Record<string, unknown>, message: string): void;
}

export function createLoggingOperatorAlerter(log: AlertLog): OperatorAlerter {
  return {
    reportPending(alert) {
      log.warn(
        { event: 'report.pending', ...alert },
        'ACTION NEEDED: new report is held as pending; call the reporter, then release or reject it',
      );
    },
  };
}
