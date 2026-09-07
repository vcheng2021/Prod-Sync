import fs from 'node:fs';
import path from 'node:path';

type LogOutcome = 'success' | 'failure' | 'info';

export interface LogIssue {
  timestamp: string;
  event: string;
  outcome: 'failure';
  details: Record<string, unknown>;
}

export interface ProductsLoadEntry {
  timestamp: string;
  productId: string;
  supplierProductKey: string;
  title: string;
  sourceUrl: string;
  fieldsLoaded: string[];
  fieldsFailed: string[];
  error: string;
  draftId: string;
}

const secretKey = /(token|secret|password|authorization|credential|cookie)/i;

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(entry)]));
};

export class AppLogger {
  private readonly logPath: string;
  private readonly productsLoadPath: string | null;

  constructor(directory: string, productsLoadPath?: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.logPath = path.join(directory, 'ecomint.log');
    this.productsLoadPath = productsLoadPath ? path.join(productsLoadPath, 'productsload.log') : null;
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

  writeError(event: string, error: Error, details?: Record<string, unknown>): void {
    this.write(event, 'failure', {
      ...details,
      errorMessage: error.message,
      stackTrace: error.stack,
    });
  }

  writeAuthEvent(event: string, outcome: LogOutcome, details: Record<string, unknown>): void {
    this.write(event, outcome, details);
  }

  writeImportEvent(event: string, details: Record<string, unknown>): void {
    this.write(event, 'failure', details);
  }

  writePublishEvent(event: string, details: Record<string, unknown>): void {
    const outcome = (details.outcome as string) ?? 'failure';
    this.write(event, outcome as LogOutcome, details);
  }

  writeEnrichmentEvent(event: string, details: Record<string, unknown>): void {
    this.write(event, 'failure', details);
  }

  writeProductsLoad(entry: ProductsLoadEntry): void {
    if (!this.productsLoadPath) return;
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(this.productsLoadPath, line, 'utf8');
  }

  readProductsLoad(limit = 100): ProductsLoadEntry[] {
    if (!this.productsLoadPath || !fs.existsSync(this.productsLoadPath)) return [];
    const entries = fs.readFileSync(this.productsLoadPath, 'utf8').split(/\r?\n/).reverse();
    const results: ProductsLoadEntry[] = [];
    for (const line of entries) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ProductsLoadEntry;
        results.push(entry);
        if (results.length >= limit) break;
      } catch {
        continue;
      }
    }
    return results;
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
