import type { Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';

/**
 * Runs work after the response without blocking it. On Vercel the function stays alive until the
 * promise settles (`waitUntil`); on a long-running server the promise simply continues.
 * Errors are logged, never thrown into the request.
 */
export function runInBackground(label: string, logger: Logger, task: () => Promise<unknown>): void {
  const promise = task().catch((error: unknown) => {
    logger.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  waitUntil(promise);
}
