/**
 * Employer-side permission catalogue. Admin has everything; a Manager has only
 * the module × action cells the platform team ticks for their role in the console.
 */
export const PERMISSION_MODULES = [
  'DASHBOARD',
  'EMPLOYEES',
  'EMPLOYEE_SALARY',
  'DEVICES',
  'SITES',
  'SHIFTS',
  'CALENDAR',
  'ATTENDANCE',
  'ATTENDANCE_MANUAL',
  'LEAVE',
  'LEAVE_SETUP',
  'PAY',
  'REPORTS',
  'SETTINGS',
  'AUDIT_LOG',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

/** Modules only an Admin can use; they never appear in the Manager matrix. */
export const ADMIN_ONLY_MODULES = ['USERS_ROLES', 'BILLING', 'FEATURES'] as const;
export type AdminOnlyModule = (typeof ADMIN_ONLY_MODULES)[number];

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type PermissionSet = Readonly<Partial<Record<PermissionModule, readonly PermissionAction[]>>>;

export const MODULE_LABELS: Readonly<Record<PermissionModule, string>> = {
  DASHBOARD: 'Dashboard',
  EMPLOYEES: 'Employees',
  EMPLOYEE_SALARY: 'Employee salary',
  DEVICES: 'Devices & activation codes',
  SITES: 'Sites & geofences',
  SHIFTS: 'Shifts & policies',
  CALENDAR: 'Holidays & weekly offs',
  ATTENDANCE: 'Attendance',
  ATTENDANCE_MANUAL: 'Manual attendance marking',
  LEAVE: 'Leave requests',
  LEAVE_SETUP: 'Leave setup',
  PAY: 'Pay monitoring',
  REPORTS: 'Reports & exports',
  SETTINGS: 'Company settings',
  AUDIT_LOG: 'Audit log',
};

export function fullPermissionSet(): PermissionSet {
  return Object.fromEntries(PERMISSION_MODULES.map((m) => [m, [...PERMISSION_ACTIONS]])) as PermissionSet;
}

export function hasPermission(
  set: PermissionSet,
  module: PermissionModule,
  action: PermissionAction,
): boolean {
  return set[module]?.includes(action) ?? false;
}
