import { currentContext } from '../context/request-context.js';

/**
 * Prisma `where` fragment limiting employee-linked rows to the Manager's branch/department
 * scope. Admins and unscoped Managers get `{}`. OR within a type, AND across types.
 */
export function employeeScopeWhere(): { branchId?: { in: string[] }; departmentId?: { in: string[] } } {
  const user = currentContext()?.tenantUser;
  if (!user || user.roleKind === 'ADMIN') {
    return {};
  }
  return {
    ...(user.branchIds.length > 0 ? { branchId: { in: [...user.branchIds] } } : {}),
    ...(user.departmentIds.length > 0 ? { departmentId: { in: [...user.departmentIds] } } : {}),
  };
}

export function isInScope(employee: { branchId: string; departmentId: string | null }): boolean {
  const user = currentContext()?.tenantUser;
  if (!user || user.roleKind === 'ADMIN') {
    return true;
  }
  const branchOk = user.branchIds.length === 0 || user.branchIds.includes(employee.branchId);
  const deptOk =
    user.departmentIds.length === 0 || (employee.departmentId !== null && user.departmentIds.includes(employee.departmentId));
  return branchOk && deptOk;
}
