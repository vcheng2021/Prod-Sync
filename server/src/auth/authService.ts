import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SESSION_TOKEN_BYTES = 32;
const SESSION_EXPIRY_MS = Number(process.env.SESSION_TIMEOUT_MS ?? 1_800_000);

export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: string;
}

export class AuthService {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    this.database.exec("CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at)");
    this.database.exec("CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id)");
  }

  register(username: string, password: string): User {
    const trimmed = username.trim();
    if (trimmed.length < 3 || trimmed.length > 64) {
      throw new Error('Username must be between 3 and 64 characters.');
    }
    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters.');
    }
    const exists = this.database.prepare('SELECT id FROM users WHERE username = ?').get(trimmed) as { id: string } | undefined;
    if (exists) throw new Error('Username already exists.');

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const storedHash = `${salt}:${passwordHash}`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const insert = this.database.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(id, trimmed, storedHash, now, now);

    return { id, username: trimmed, createdAt: now };
  }

  login(username: string, password: string): Session {
    const trimmed = username.trim();
    const user = this.database.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(trimmed) as { id: string; password_hash: string } | undefined;
    if (!user) throw new Error('Invalid username or password.');

    const [salt, hash] = user.password_hash.split(':');
    if (!salt || !hash) throw new Error('Invalid username or password.');

    const derivedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    // Use constant-time comparison
    const expected = Buffer.from(derivedHash, 'hex');
    const actual = Buffer.from(hash, 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new Error('Invalid username or password.');
    }

    // Clean up expired sessions
    this.database.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(new Date().toISOString());

    const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    const insert = this.database.prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
    insert.run(token, user.id, new Date().toISOString(), expiresAt);

    return { token, userId: user.id, expiresAt };
  }

  validateSession(token: string): User | null {
    if (!token) return null;
    const session = this.database.prepare('SELECT us.user_id, u.username, u.created_at FROM user_sessions us JOIN users u ON us.user_id = u.id WHERE us.token = ? AND us.expires_at > ?').get(token, new Date().toISOString()) as { user_id: string; username: string; created_at: string } | undefined;
    if (!session) return null;
    return { id: session.user_id, username: session.username, createdAt: session.created_at };
  }

  logout(token: string): void {
    this.database.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  }

  cleanupExpiredSessions(): void {
    this.database.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(new Date().toISOString());
  }

  getUserById(id: string): User | null {
    const row = this.database.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id) as { id: string; username: string; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, username: row.username, createdAt: row.created_at };
  }

  hasUsers(): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM users LIMIT 1').get());
  }
}
