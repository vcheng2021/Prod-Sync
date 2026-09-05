import fs from 'node:fs';
import path from 'node:path';

type LogOutcome = 'success' | 'failure' | 'info';

export interface LogIssue {
  timestamp: string;
  event: string;
  outcome: 'failure';
  details: Record<string, unknown>;
}

const secretKey = /(token|secret|password|authorization|credential|cookie)/i;

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(entry)]));
};

export class AppLogger {
  private readonly logPath: string;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.logPath = path.join(directory, 'ecomint.log');
  }

  write(event: string, outcome: LogOutcome, details: Record<string, unknown> = {}): void {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      outcome,
      details: redact(details),
    };
    fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}${path.sep === '\\' ? '\r\n' : '\n'}`, 'utf8');
  }

  readIssues(limit = 1000): LogIssue[] {
    if (!fs.existsSync(this.logPath)) return [];
    const entries = fs.readFileSync(this.logPath, 'utf8').split(/\r?\n/).reverse();
    const issues: LogIssue[] = [];
    for (const line of entries) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: unknown; event?: unknown; outcome?: unknown; details?: unknown };
        if (typeof entry.timestamp !== 'string' || typeof entry.event !== 'string' || entry.outcome !== 'failure' || !entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) continue;
        issues.push({ timestamp: entry.timestamp, event: entry.event, outcome: 'failure', details: entry.details as Record<string, unknown> });
        if (issues.length >= limit) break;
      } catch {
        continue;
      }
    }
    return issues;
  }
}
