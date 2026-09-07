import { Router } from 'express';
import { AuthService } from './authService.js';
import { parseCookies } from './authMiddleware.js';
import { AppLogger } from '../logging/logger.js';
import { getPlatformClient, isPlatformAvailable } from '../platforms/publisher.js';
import { STANDARD_HEADERS } from '../imports/standardFormat.js';

export function createAuthRouter(authService: AuthService, logger: AppLogger): Router {
  const router = Router();

  router.post('/register', (request, response) => {
    try {
      const { username, password } = request.body ?? {};
      if (!username || !password) {
        return response.status(400).json({ error: 'Username and password are required.' });
      }
      const user = authService.register(username, password);
      logger.write('auth.register', 'success', { username: user.username });
      return response.status(201).json({ ok: true, user: { id: user.id, username: user.username } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed.';
      logger.write('auth.register', 'failure', { error: message });
      return response.status(400).json({ error: message });
    }
  });

  router.post('/login', (request, response) => {
    try {
      const { username, password } = request.body ?? {};
      if (!username || !password) {
        return response.status(400).json({ error: 'Username and password are required.' });
      }
      const session = authService.login(username, password);
      response.cookie('session_token', session.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: Number(process.env.SESSION_TIMEOUT_MS ?? 1_800_000),
        path: '/',
      });
      logger.write('auth.login', 'success', { username });
      return response.json({ ok: true, user: { id: session.userId, username: username.trim() } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed.';
      logger.write('auth.login', 'failure', { error: message });
      return response.status(401).json({ error: message });
    }
  });

  router.post('/logout', (request, response) => {
    const token = parseCookies(request.headers.cookie).session_token;
    if (token) {
      authService.logout(token);
    }
    response.clearCookie('session_token');
    logger.write('auth.logout', 'success');
    return response.json({ ok: true });
  });

  router.get('/me', (request, response) => {
    const token = parseCookies(request.headers.cookie).session_token;
    if (!token) {
      return response.json({ authenticated: false });
    }
    const user = authService.validateSession(token);
    if (!user) {
      response.clearCookie('session_token');
      return response.json({ authenticated: false });
    }
    return response.json({ authenticated: true, user: { id: user.id, username: user.username, createdAt: user.createdAt } });
  });

  // ── Platform configuration ──

  router.get('/platforms', (request, response) => {
    return response.json({
      platforms: [
        { name: 'shopify', label: 'Shopify', available: true },
        { name: 'woocommerce', label: 'WooCommerce', available: isPlatformAvailable('woocommerce') },
      ],
    });
  });

  router.get('/sources', (request, response) => {
    return response.json({
      sources: [
        { id: 'paramount', name: 'paramount', displayName: 'Cellar (Paramount Liquor)', platform: 'shopify' },
        { id: 'aliexpress', name: 'aliexpress', displayName: 'AliExpress (Vican)', platform: 'shopify' },
        { id: 'ebay', name: 'ebay', displayName: 'eBay', platform: 'shopify' },
      ],
      standardHeaders: STANDARD_HEADERS,
    });
  });

  router.get('/platform-config/:platform', (request, response) => {
    const { platform } = request.params;
    // authService needs platform config access — handled by store method
    // Placeholder: actual implementation in draftStore
    return response.json({ platform, configured: false });
  });

  return router;
}
