/**
 * Permission Broker
 *
 * When permissionMode === 'webhook':
 *   1. canUseTool fires → broker intercepts
 *   2. Persists to pending_permissions
 *   3. POSTs to Arbiter (HMAC-SHA256 signed)
 *   4. Waits for callback (or times out after 55s)
 *   5. Resolves via resolveToolApproval
 *
 * Callback endpoint is mounted by the router at:
 *   POST /api/orchestration/callbacks/permission
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { resolveToolApproval } from '../claude-sdk.js';
import {
  createPendingPermission,
  getPendingPermission,
  updatePermissionDecision,
  incrementPermissionCallbackAttempts,
} from './db.js';
import { emitEvent } from './eventStream.js';

const ARBITER_URL      = process.env.ARBITER_URL      || 'http://127.0.0.1:7300';
const ARBITER_SECRET   = process.env.ARBITER_SECRET   || '';
const PERMISSION_TIMEOUT_MS = parseInt(process.env.PERMISSION_TIMEOUT_MS, 10) || 55_000;

// Map of requestId → { resolve, timer }
const pendingCallbacks = new Map();

function hmacSign(body) {
  if (!ARBITER_SECRET) return '';
  return 'sha256=' + crypto.createHmac('sha256', ARBITER_SECRET).update(body).digest('hex');
}

function verifySignature(rawBody, signature) {
  if (!ARBITER_SECRET) return true; // no secret configured → trust all
  const expected = 'sha256=' + crypto.createHmac('sha256', ARBITER_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Wait for a permission decision via Promise.
 * Resolves with { allow: true } or { allow: false, message: string }.
 */
function waitForDecision(requestId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCallbacks.delete(requestId);
      updatePermissionDecision(requestId, {
        status: 'timed_out',
        source: 'timeout',
        reason: 'No decision received within timeout',
        decidedAt: new Date().toISOString(),
      });
      emitEvent('session.permission_decided', {
        requestId,
        decision: 'deny',
        source: 'timeout',
        reason: 'Permission request timed out',
      });
      resolve({ allow: false, message: 'Permission request timed out' });
    }, PERMISSION_TIMEOUT_MS);

    pendingCallbacks.set(requestId, { resolve, timer });
  });
}

/**
 * Handle an incoming callback from Arbiter (or direct decision from Linus).
 * Also called by the /sessions/:id/permissions/:requestId/decide endpoint.
 *
 * @param {string} requestId
 * @param {string} decision   'allow' | 'deny'
 * @param {string} source     'policy' | 'linus' | 'angus' | 'timeout'
 * @param {string} reason
 */
function resolveDecision(requestId, decision, source = 'linus', reason = '') {
  const entry = getPendingPermission(requestId);
  if (!entry) return { ok: false, error: 'Permission request not found' };
  if (entry.status !== 'pending') return { ok: false, error: 'Already decided', code: 'ALREADY_DECIDED' };

  const decidedAt = new Date().toISOString();
  const status = decision === 'allow' ? 'allowed' : 'denied';

  updatePermissionDecision(requestId, { status, source, reason, decidedAt });

  // Notify SSE clients
  emitEvent('session.permission_decided', {
    sessionId: entry.session_id,
    requestId,
    decision,
    source,
  });

  // Resolve the waiting promise (if any)
  const pending = pendingCallbacks.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCallbacks.delete(requestId);
    // Resolve the Claude SDK waitForToolApproval
    const sdkDecision = decision === 'allow' ? { allow: true } : { allow: false, message: reason || 'Denied' };
    resolveToolApproval(requestId, sdkDecision);
    pending.resolve(sdkDecision);
  }

  return { ok: true };
}

/**
 * Build a canUseTool interceptor for webhook permission mode.
 *
 * @param {string} sessionId
 * @param {string} projectPath
 * @param {string} provider
 * @param {string} serverBaseUrl  e.g. 'https://localhost:3001'
 * @returns {function} canUseTool async function
 */
function buildWebhookCanUseTool(sessionId, projectPath, provider, serverBaseUrl, origin = {}) {
  return async function webhookCanUseTool(toolName, input) {
    const requestId = 'perm-' + crypto.randomBytes(8).toString('hex');
    const requestedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PERMISSION_TIMEOUT_MS).toISOString();
    const callbackUrl = `${serverBaseUrl}/api/orchestration/callbacks/permission`;

    // Persist
    createPendingPermission({ requestId, sessionId, tool: toolName, input, requestedAt, expiresAt });

    // Emit SSE event
    emitEvent('session.permission_requested', {
      sessionId,
      requestId,
      tool: toolName,
      input,
      expiresAt,
    });

    // POST to Arbiter
    const payload = JSON.stringify({
      sessionId,
      requestId,
      tool: toolName,
      input,
      projectPath,
      provider,
      callbackUrl,
      expiresAt,
      originSessionKey: origin.originSessionKey || null,
      originChannel: origin.originChannel || null,
      originAccountId: origin.originAccountId || null,
      originChatId: origin.originChatId || null,
    });

    const sig = hmacSign(payload);

    try {
      const resp = await fetch(`${ARBITER_URL}/api/permissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sig ? { 'X-Signature': sig } : {}),
        },
        body: payload,
        // Don't wait forever for Arbiter itself
        signal: AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
      });

      incrementPermissionCallbackAttempts(requestId);

      if (!resp.ok) {
        console.warn(`[PermissionBroker] Arbiter returned ${resp.status} for ${requestId}`);
      }
    } catch (err) {
      console.warn(`[PermissionBroker] Failed to reach Arbiter for ${requestId}: ${err.message}`);
      // Continue waiting — decision may still arrive via direct /decide endpoint
    }

    // Wait for resolution
    const decision = await waitForDecision(requestId);
    return decision.allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.message ?? 'Denied' };
  };
}

/**
 * Express middleware to handle Arbiter→CloudCLI callbacks.
 * Mount at POST /api/orchestration/callbacks/permission
 */
function handlePermissionCallback(req, res) {
  // Signature verification
  if (ARBITER_SECRET) {
    const rawBody = JSON.stringify(req.body);
    const sig = req.headers['x-signature'] || '';
    if (!verifySignature(rawBody, sig)) {
      return res.status(401).json({ error: 'Invalid signature', code: 'BAD_SIGNATURE' });
    }
  }

  const { requestId, decision, source, reason } = req.body;
  if (!requestId || !decision) {
    return res.status(400).json({ error: 'requestId and decision required', code: 'MISSING_FIELDS' });
  }

  const result = resolveDecision(requestId, decision, source || 'policy', reason || '');
  if (!result.ok) {
    const status = result.code === 'ALREADY_DECIDED' ? 409 : 404;
    return res.status(status).json({ error: result.error, code: result.code });
  }

  return res.json({ ok: true, requestId });
}

export {
  buildWebhookCanUseTool,
  handlePermissionCallback,
  resolveDecision,
  verifySignature,
};
