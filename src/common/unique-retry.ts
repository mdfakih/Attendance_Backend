/** Prisma's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/**
 * Upserts through the tenant extension carry an extra `tenantId` in `where`, so Prisma runs them as
 * read-then-write rather than a native `ON CONFLICT`. Two concurrent first writes can then collide;
 * the second attempt sees the winner's row and takes the update path.
 */
export async function retryOnUniqueViolation<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error;
    return write();
  }
}
