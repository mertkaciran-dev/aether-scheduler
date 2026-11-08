import { parseExpression } from 'cron-parser';

export function validateCron(pattern: string, tz?: string): string | null {
  try {
    parseExpression(pattern, { tz, currentDate: new Date() }).next();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid cron expression';
  }
}

export function nextCronRun(pattern: string, tz?: string, from: Date = new Date()): Date {
  return parseExpression(pattern, { tz, currentDate: from }).next().toDate();
}
