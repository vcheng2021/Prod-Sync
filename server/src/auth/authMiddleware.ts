import type { Request, Response, NextFunction } from 'express';
import { AuthService } from './authService.js';
import { AppLogger } from '../logging/logger.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [rawKey, ...rawValue] = pair.trim().split('=');
    if (rawKey && rawValue.length) {
      cookies[rawKey] = rawValue.join('=').trim();
    }
  }
  return cookies;
}

export function createAuthMiddleware(authService: AuthService, logger: AppLogger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.session_token ?? request.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      request.userId = undefined;
      logger.writeAuthEvent('auth.missing_token', 'failure', {
        path: request.path,
        reason: 'No session token provided',
      });
      if (request.path.startsWith('/api/') && !request.path.startsWith('/api/auth/') && request.path !== '/api/health' && request.path !== '/api/ready') {
        response.status(401).json({ error: 'Authentication required.' });
        return;
      }
      next();
      return;
    }
    const user = authService.validateSession(token);
    if (!user) {
      logger.writeAuthEvent('auth.session_expired', 'failure', {
        path: request.path,
        reason: 'Invalid or expired session token',
      });
      response.clearCookie('session_token');
      request.userId = undefined;
      if (request.path.startsWith('/api/') && !request.path.startsWith('/api/auth/') && request.path !== '/api/health' && request.path !== '/api/ready') {
        response.status(401).json({ error: 'Session expired.' });
        return;
      }
      next();
      return;
    }
    request.userId = user.id;
    logger.writeAuthEvent('auth.authenticated', 'success', {
      path: request.path,
      userId: user.id,
    });
    next();
  };
}
