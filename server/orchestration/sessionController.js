/**
 * Session Controller
 *
 * Wraps existing CloudCLI provider functions to create/manage orchestration sessions.
 * Does NOT touch existing WS handlers or routes.
 *
 * Providers:
 *   - claude  → queryClaudeSDK / abortClaudeSDKSession
 *   - codex   → queryCodex / abortCodexSession
 *   - gemini  → spawnGemini / abortGeminiSession
 *   - cursor  → spawnCursor / abortCursorSession
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

import { queryClaudeSDK, abortClaudeSDKSession } from '../claude-sdk.js';
import { queryCodex, abortCodexSession } from '../openai-codex.js';
import { spawnGemini, abortGeminiSession } from '../gemini-cli.js';
import { spawnCursor, abortCursorSession } from '../cursor-cli.js';

import {
  createOrchestrationSession,
  getOrchestrationSession,
  listOrchestrationSessions,
  updateOrchestrationSession,
  getQueuedInstructions,
  getPendingPermissionsForSession,
} from './db.js';
import { emitEvent } from './eventStream.js';
import { updateContextUsage, clearSessionThresholds } from './contextMonitor.js';
import { onSessionIdle, onSessionEnded, registerDeliveryCallback } from './instructionQueue.js';
import { buildWebhookCanUseTool } from './permissionBroker.js';

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:3000';
const VALID_PROVIDERS = ['claude', 'codex', 'gemini', 'cursor'];
const VALID_PERMISSION_MODES = ['webhook', 'bypassPermissions', 'ui'];

function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Build a lightweight "ws" adapter that translates WS-style messages into
 * orchestration SSE events, token tracking, and idle detection.
 */
function buildWsAdapter(sessionId, { onComplete, onError } = {}) {
  const adapter = {
    _sessionId: sessionId,
    setSessionId(id) { this._sessionId = id; },
    send(msg) {
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { return; }
      }

      // Capture CC subprocess session ID from any message that carries it.
      // session-created only fires for new sessions; on resume the SDK skips it.
      // claude-response always includes sessionId once captured by the SDK.
      if (msg?.sessionId && msg.sessionId !== this._sessionId) {
        const sess = getOrchestrationSession(this._sessionId);
        if (sess && !sess.cc_session_id) {
          console.log(`[SessionController] Captured CC session ID ${msg.sessionId} for orchestration session ${this._sessionId} (from ${msg.type})`);
          updateOrchestrationSession(this._sessionId, { cc_session_id: msg.sessionId });
        }
      }

      switch (msg?.type) {
        case 'claude-response': {
          const d = msg.data;
          if (!d) break;
          // NOTE: session.message, session.tool_use, session.tool_result deliberately
          // NOT emitted to SSE. Streaming every tool call and assistant message would
          // flood the consumer's context window and nearly double token usage.
          // Use GET /sessions/:id/messages for on-demand history instead.

          if (d.type === 'result') {
            // context monitor
            if (d.modelUsage) {
              const modelKey = Object.keys(d.modelUsage)[0];
              const mu = d.modelUsage[modelKey];
              if (mu) {
                const used =
                  (mu.cumulativeInputTokens || mu.inputTokens || 0) +
                  (mu.cumulativeOutputTokens || mu.outputTokens || 0) +
                  (mu.cumulativeCacheReadInputTokens || mu.cacheReadInputTokens || 0) +
                  (mu.cumulativeCacheCreationInputTokens || mu.cacheCreationInputTokens || 0);
                const total = parseInt(process.env.CONTEXT_WINDOW) || 160000;
                updateContextUsage(this._sessionId, used, total);
              }
            }
          }
          break;
        }

        case 'token-budget': {
          const { used, total } = msg.data || {};
          if (used != null && total != null) {
            updateContextUsage(this._sessionId, used, total);
          }
          break;
        }

        case 'claude-complete':
        case 'codex-complete':
        case 'gemini-complete':
        case 'cursor-complete': {
          const now = new Date().toISOString();
          updateOrchestrationSession(this._sessionId, { status: 'idle', last_activity_at: now });
          emitEvent('session.idle', { sessionId: this._sessionId, reason: 'task_complete' });
          onSessionIdle(this._sessionId).catch(err =>
            console.error('[SessionController] onSessionIdle error:', err.message)
          );
          onComplete?.();
          break;
        }

        case 'claude-error':
        case 'codex-error':
        case 'gemini-error':
        case 'cursor-error': {
          const now = new Date().toISOString();
          updateOrchestrationSession(this._sessionId, { status: 'error', last_activity_at: now });
          emitEvent('session.error', {
            sessionId: this._sessionId,
            error: msg.error || 'Provider error',
            recoverable: false,
          });
          onSessionEnded(this._sessionId);
          onError?.(msg.error);
          break;
        }

        case 'session-created': {
          // CC session ID capture handled by the generic check above.
          // Update last_activity_at on session creation.
          if (msg.sessionId && msg.sessionId !== this._sessionId) {
            updateOrchestrationSession(this._sessionId, { last_activity_at: new Date().toISOString() });
          }
          break;
        }

        case 'claude-permission-request': {
          // This fires when permissionMode === 'ui' (WS passthrough).
          // For 'webhook' mode the broker intercepts before this point.
          break;
        }

        default:
          break;
      }
    },
  };

  return adapter;
}

/**
 * Compute permissionMode flags for the SDK options object.
 */
function resolvePermissionFlags(permissionMode) {
  switch (permissionMode) {
    case 'bypassPermissions':
      return { permissionMode: 'bypassPermissions', skipPermissions: true };
    case 'ui':
      return { permissionMode: 'default' };
    case 'webhook':
    default:
      return { permissionMode: 'default' };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create and start a new orchestration session.
 */
async function startSession(opts) {
  const {
    projectPath,
    provider = 'claude',
    model,
    message,
    sessionId: resumeId,
    permissionMode = 'webhook',
    label,
    originSessionKey,
    originChannel,
    originAccountId,
    originChatId,
  } = opts;

  if (!projectPath) throw Object.assign(new Error('projectPath is required'), { statusCode: 400, code: 'MISSING_PROJECT_PATH' });
  if (!message)     throw Object.assign(new Error('message is required'), { statusCode: 400, code: 'MISSING_MESSAGE' });
  if (!VALID_PROVIDERS.includes(provider)) {
    throw Object.assign(new Error(`Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}`), { statusCode: 400, code: 'INVALID_PROVIDER' });
  }
  if (!VALID_PERMISSION_MODES.includes(permissionMode)) {
    throw Object.assign(new Error(`Invalid permissionMode`), { statusCode: 400, code: 'INVALID_PERMISSION_MODE' });
  }

  const id = newSessionId();
  const startedAt = new Date().toISOString();

  createOrchestrationSession({
    id, provider, projectPath, model, label,
    status: 'running', permissionMode, startedAt,
    originSessionKey,
    originChannel,
    originAccountId,
    originChatId,
  });

  // session.started not emitted to SSE — caller gets the response directly

  // Build shared options
  const permFlags = resolvePermissionFlags(permissionMode);
  const baseOptions = {
    cwd: projectPath,
    model: model || undefined,
    sessionId: resumeId || undefined,
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: permFlags.skipPermissions || false },
    permissionMode: permFlags.permissionMode,
  };

  const wsAdapter = buildWsAdapter(id, {
    onComplete: () => {
      updateOrchestrationSession(id, { last_activity_at: new Date().toISOString() });
    },
    onError: () => {
      clearSessionThresholds(id);
    },
  });

  // Register delivery callback for instruction queue
  registerDeliveryCallback(id, async (msg) => {
    const deliverAdapter = buildWsAdapter(id);
    // Read the real CC subprocess session ID from DB (captured during first query).
    // This is the ID CC uses internally — NOT our orchestration UUID.
    // Without this, resume fails with exit code 1 because the SDK can't find
    // a session matching the orchestration UUID in CC's session store.
    const freshSession = getOrchestrationSession(id);
    const resumeSessionId = freshSession?.cc_session_id || resumeId || id;
    console.log(`[SessionController] Delivering instruction to ${id}, resuming CC session ${resumeSessionId}`);
    const opts2 = { ...baseOptions, sessionId: resumeSessionId };
    await runProvider(provider, msg, opts2, deliverAdapter, id, permissionMode, projectPath);
  });

  // Webhook: override canUseTool
  if (permissionMode === 'webhook' && provider === 'claude') {
    const webhookFn = buildWebhookCanUseTool(
      id,
      projectPath,
      provider,
      SERVER_BASE_URL,
      {
        originSessionKey,
        originChannel,
        originAccountId,
        originChatId,
      },
    );
    baseOptions._externalCanUseTool = async (toolName, input, context) => {
      const result = await webhookFn(toolName, input);
      return result; // { behavior: 'allow'|'deny', message?: string }
    };
  }

  // Fire and forget (don't await — the session runs async)
  runProvider(provider, message, baseOptions, wsAdapter, id, permissionMode, projectPath).catch(err => {
    console.error(`[SessionController] runProvider error for ${id}:`, err.message);
    updateOrchestrationSession(id, { status: 'error', ended_at: new Date().toISOString() });
    emitEvent('session.error', { sessionId: id, error: err.message, recoverable: false });
    onSessionEnded(id);
  });

  return getOrchestrationSession(id);
}

async function runProvider(provider, message, options, wsAdapter, sessionId, permissionMode, projectPath) {
  // Patch canUseTool for webhook mode (claude only)
  if (permissionMode === 'webhook' && provider === 'claude' && options._webhookCanUseTool) {
    // We inject canUseTool into queryClaudeSDK via a patched ws send — but the SDK
    // reads canUseTool from the sdkOptions object. We pass it as a special option
    // that mapCliOptionsToSDK will ignore (since it only reads known fields).
    // Instead we override it after the fact via a wrapped queryClaudeSDK.
    // The cleanest approach: pass it through options and intercept in a wrapper.
    options = { ...options, _orchWebhookCanUseTool: options._webhookCanUseTool };
  }

  const startedAt = new Date().toISOString();
  updateOrchestrationSession(sessionId, { status: 'running', last_activity_at: startedAt });

  try {
    switch (provider) {
      case 'claude':
        // _externalCanUseTool is set on options for webhook mode,
        // claude-sdk.js reads it directly in its canUseTool callback
        await queryClaudeSDK(message, options, wsAdapter);
        break;
      case 'codex':
        await queryCodex(message, options, wsAdapter);
        break;
      case 'gemini':
        await spawnGemini(message, { ...options, projectPath }, wsAdapter);
        break;
      case 'cursor':
        await spawnCursor(message, options, wsAdapter);
        break;
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  } finally {
    // Fallback: if provider returned without emitting *-complete, don't hard-end.
    // Mark idle and trigger queued instruction delivery.
    // Why: hard-ending here races with instruction queue handoff and can expire
    // queued instructions before they are delivered.
    const sess = getOrchestrationSession(sessionId);
    if (sess && sess.status === 'running') {
      const now = new Date().toISOString();
      updateOrchestrationSession(sessionId, { status: 'idle', last_activity_at: now });
      emitEvent('session.idle', { sessionId, reason: 'provider_return_fallback' });
      onSessionIdle(sessionId).catch(err =>
        console.error('[SessionController] onSessionIdle fallback error:', err.message)
      );
    }
  }
}

/**
 * Wraps queryClaudeSDK to inject the webhook canUseTool.
 * We monkey-patch the sdkOptions.canUseTool by intercepting the call inside
 * the sdk module. Since we can't easily modify the inner sdkOptions after
 * mapCliOptionsToSDK runs, we pass the hook via a special wrapper.
 *
 * Strategy: set a process-level override that the claude-sdk.js canUseTool reads.
 * Actually, the cleanest approach without modifying claude-sdk.js is to use the
 * "bypassPermissions" mode = false AND override via a special env or via direct injection.
 *
 * Real approach: inject canUseTool as a property on the options object with the
 * special name `canUseTool`, which mapCliOptionsToSDK will pass through since
 * it copies into sdkOptions.
 *
 * Looking at the actual mapCliOptionsToSDK code: it does NOT copy canUseTool.
 * The function sets sdkOptions.canUseTool AFTER mapCliOptionsToSDK in queryClaudeSDK itself.
 *
 * Since queryClaudeSDK is ESM and we can't monkey-patch it, the cleanest approach
 * is to use a wrapper that re-implements the permission logic via the existing
 * `resolveToolApproval` mechanism combined with a pre-approval map.
 *
 * Simpler: for webhook mode, we'll use the bypassPermissions mode internally
 * but intercept each tool call via our own canUseTool before Claude sees it.
 * We do this by temporarily overriding the ws.send to catch permission requests
 * and rerouting them through the broker.
 */
async function queryClaudeSDKWithWebhook(message, options, wsAdapter, sessionId) {
  console.log('[WebhookHook] Starting webhook-mode session', sessionId);
  const webhookFn = options._orchWebhookCanUseTool;

  // Create a patched ws that intercepts claude-permission-request messages
  const patchedWs = {
    ...wsAdapter,
    _pendingPermissions: new Map(),
    send(msg) {
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { return wsAdapter.send(msg); }
      }

      if (msg?.type === 'claude-permission-request') {
        console.log('[WebhookHook] Intercepted permission request:', msg.toolName, msg.requestId);
        // Route through webhook broker instead of WS relay
        const { requestId, toolName, input } = msg;
        webhookFn(toolName, input).then(sdkDecision => {
          // resolveToolApproval maps requestId → { allow, message }
          const { resolveToolApproval } = options._resolveToolApproval || {};
          // The claude-sdk.js pendingToolApprovals map is keyed by requestId
          // and resolveToolApproval is exported directly.
          import('../claude-sdk.js').then(({ resolveToolApproval }) => {
            const allow = sdkDecision.behavior === 'allow';
            resolveToolApproval(requestId, allow ? { allow: true } : { allow: false, message: sdkDecision.message });
          }).catch(err => console.error('[WebhookHook] resolve error:', err.message));
        }).catch(err => {
          console.error('[WebhookHook] webhookFn error:', err.message);
          import('../claude-sdk.js').then(({ resolveToolApproval }) => {
            resolveToolApproval(requestId, { allow: false, message: err.message });
          });
        });
        return; // Don't forward to wsAdapter
      }

      wsAdapter.send(msg);
    },
    setSessionId(id) { wsAdapter.setSessionId(id); },
  };

  await queryClaudeSDK(message, options, patchedWs);
}

/**
 * Get detailed session info including queue and pending permissions.
 */
function getSessionDetail(id) {
  const session = getOrchestrationSession(id);
  if (!session) return null;

  const instructionQueue = getQueuedInstructions(id);
  const pendingPermissions = getPendingPermissionsForSession(id);

  return {
    id: session.id,
    projectPath: session.project_path,
    provider: session.provider,
    model: session.model,
    status: session.status,
    label: session.label,
    permissionMode: session.permission_mode,
    origin: {
      sessionKey: session.origin_session_key || null,
      channel: session.origin_channel || null,
      accountId: session.origin_account_id || null,
      chatId: session.origin_chat_id || null,
    },
    startedAt: session.started_at,
    lastActivityAt: session.last_activity_at,
    endedAt: session.ended_at,
    contextUsage: {
      used: session.context_used,
      total: session.context_total,
      percent: session.context_total > 0
        ? Math.round((session.context_used / session.context_total) * 1000) / 10
        : 0,
    },
    pendingInstructions: instructionQueue.length,
    instructionQueue: instructionQueue.map(i => ({
      id: i.id,
      message: i.message,
      queuedAt: i.queued_at,
      status: i.status,
      priority: i.priority,
    })),
    pendingPermissions: pendingPermissions.map(p => ({
      requestId: p.request_id,
      tool: p.tool,
      input: JSON.parse(p.input_json),
      requestedAt: p.requested_at,
      expiresAt: p.expires_at,
    })),
    eventsUrl: `/api/orchestration/events?sessionId=${id}`,
  };
}

/**
 * List sessions (row-level view).
 */
function listSessions(filters) {
  const rows = listOrchestrationSessions(filters);
  return rows.map(session => ({
    id: session.id,
    projectPath: session.project_path,
    provider: session.provider,
    status: session.status,
    label: session.label,
    origin: {
      sessionKey: session.origin_session_key || null,
      channel: session.origin_channel || null,
      accountId: session.origin_account_id || null,
      chatId: session.origin_chat_id || null,
    },
    startedAt: session.started_at,
    lastActivityAt: session.last_activity_at,
    contextUsage: {
      used: session.context_used,
      total: session.context_total,
      percent: session.context_total > 0
        ? Math.round((session.context_used / session.context_total) * 1000) / 10
        : 0,
    },
    pendingInstructions: getQueuedInstructions(session.id).length,
  }));
}

/**
 * Abort a running session.
 */
async function abortSession(id, reason) {
  const session = getOrchestrationSession(id);
  if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404, code: 'SESSION_NOT_FOUND' });

  const abortedAt = new Date().toISOString();

  let aborted = false;
  switch (session.provider) {
    case 'claude': aborted = await abortClaudeSDKSession(id); break;
    case 'codex':  aborted = await abortCodexSession(id);     break;
    case 'gemini': aborted = await abortGeminiSession(id);    break;
    case 'cursor': aborted = await abortCursorSession(id);    break;
  }

  updateOrchestrationSession(id, { status: 'aborted', ended_at: abortedAt });
  emitEvent('session.ended', { sessionId: id, reason: reason || 'aborted' });
  onSessionEnded(id);
  clearSessionThresholds(id);

  return { id, status: 'aborted', abortedAt };
}

export { startSession, getSessionDetail, listSessions, abortSession };
