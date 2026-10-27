/** BullMQ queue names and job payload types. Every tenant job carries `tenantId`. */
export const QUEUE = {
  ATTENDANCE: 'attendance',
  PAY: 'pay',
  EXPORTS: 'exports',
  NOTIFY: 'notify',
  MAINTENANCE: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface RecomputeDayJob {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly date: string;
}

export interface RecomputeRangeJob {
  readonly tenantId: string;
  readonly employeeIds: readonly string[] | 'ALL';
  readonly from: string;
  readonly to: string;
}

export interface RecomputePayJob {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly month: string;
}

export interface ExportJobData {
  readonly tenantId: string;
  readonly exportJobId: string;
}

export interface PushJob {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
}

export interface EmailJob {
  readonly tenantId: string | null;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface TenantJob {
  readonly tenantId: string;
}
