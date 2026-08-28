import fs from 'node:fs';
import path from 'node:path';

type LogOutcome = 'success' | 'failure' | 'info';

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
}
