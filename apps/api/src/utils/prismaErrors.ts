/** Whether a Prisma error is a unique constraint violation (P2002): a row with the same key exists. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'P2002';
}
