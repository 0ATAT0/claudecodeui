/**
 * Orchestration auth middleware
 *
 * Accepts either:
 *   1. Authorization: Bearer <ORCHESTRATION_API_KEY>  (machine client)
 *   2. Authorization: Bearer <JWT>                    (human / browser)
 *   3. ?token=<JWT>                                   (SSE EventSource)
 */

import jwt from 'jsonwebtoken';
import { userDb } from '../database/db.js';
import { IS_PLATFORM } from '../constants/config.js';

const JWT_SECRET = process.env.JWT_SECRET || 'claude-ui-dev-secret-change-in-production';
const ORCHESTRATION_API_KEY = process.env.ORCHESTRATION_API_KEY;

function orchestrationAuth(req, res, next) {
  // Platform mode: bypass, use first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: no user in database', code: 'PLATFORM_NO_USER' });
      }
      req.user = user;
      req.authSource = 'platform';
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'Platform mode auth error', code: 'PLATFORM_ERROR' });
    }
  }

  // Extract token from Authorization header or query param
  const authHeader = req.headers['authorization'];
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token && req.query.token) token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.', code: 'NO_TOKEN' });
  }

  // 1. Check for orchestration API key (machine client)
  if (ORCHESTRATION_API_KEY && token === ORCHESTRATION_API_KEY) {
    req.user = { id: 0, username: 'orchestration-machine' };
    req.authSource = 'api-key';
    return next();
  }

  // 2. Try JWT (human client)
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.', code: 'USER_NOT_FOUND' });
    }
    req.user = user;
    req.authSource = 'jwt';
    return next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
}

export { orchestrationAuth };
