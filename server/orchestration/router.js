/**
 * Orchestration Router
 *
 * Mounts all /api/orchestration/* endpoints.
 * All routes require orchestrationAuth (API key or JWT).
 *
 * Endpoints:
 *   POST   /sessions
 *   GET    /sessions
 *   GET    /sessions/:id
 *   POST   /sessions/:id/abort
 *   POST   /sessions/:id/messages
 *   GET    /sessions/:id/messages
 *   POST   /sessions/:id/permissions/:requestId/decide
 *   GET    /events
 *   POST   /callbacks/permission          ← Arbiter callback (signature-verified)
 */

import express from 'express';
import { orchestrationAuth } from './auth.js';
import { attachSseClient } from './eventStream.js';
import { addInstruction } from './instructionQueue.js';
import { handlePermissionCallback, resolveDecision } from './permissionBroker.js';
import { startSession, getSessionDetail, listSessions, abortSession } from './sessionController.js';
import {
  getOrchestrationSession,
  getQueuedInstructions,
  getPendingPermissionsForSession,
} from './db.js';

const router = express.Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

function apiError(res, statusCode, message, code, details) {
  return res.status(statusCode).json({
    error: message,
    code: code || 'ERROR',
    ...(details ? { details } : {}),
  });
}

// ─── Callbacks (no auth — Arbiter POSTs here) ───────────────────────────────

router.post('/callbacks/permission', express.json(), handlePermissionCallback);

// ─── All other routes require auth ──────────────────────────────────────────

router.use(orchestrationAuth);

// ─── Session Lifecycle ───────────────────────────────────────────────────────

// POST /sessions — create/start session
router.post('/sessions', async (req, res) => {
  try {
    const session = await startSession(req.body);
    const detail = getSessionDetail(session.id);
    return res.status(201).json({
      id: detail.id,
      projectPath: detail.projectPath,
      provider: detail.provider,
      model: detail.model,
      status: detail.status,
      label: detail.label,
      origin: detail.origin,
      startedAt: detail.startedAt,
      eventsUrl: detail.eventsUrl,
    });
  } catch (err) {
    return apiError(res, err.statusCode || 500, err.message, err.code);
  }
});

// GET /sessions — list sessions
router.get('/sessions', (req, res) => {
  try {
    const { status, provider, projectPath, limit } = req.query;
    const sessions = listSessions({
      status,
      provider,
      projectPath,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    return res.json({ sessions });
  } catch (err) {
    return apiError(res, 500, err.message, 'LIST_ERROR');
  }
});

// GET /sessions/:id — session detail
router.get('/sessions/:id', (req, res) => {
  const detail = getSessionDetail(req.params.id);
  if (!detail) return apiError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  return res.json(detail);
});

// POST /sessions/:id/abort
router.post('/sessions/:id/abort', async (req, res) => {
  try {
    const result = await abortSession(req.params.id, req.body?.reason);
    return res.json(result);
  } catch (err) {
    return apiError(res, err.statusCode || 500, err.message, err.code);
  }
});

// ─── Instruction Queue ───────────────────────────────────────────────────────

// POST /sessions/:id/messages — enqueue or deliver instruction
router.post('/sessions/:id/messages', async (req, res) => {
  const { message, priority } = req.body || {};
  if (!message) return apiError(res, 400, 'message is required', 'MISSING_MESSAGE');

  try {
    const { instruction, status } = await addInstruction(req.params.id, message, priority);
    const httpStatus = status === 'delivered' ? 200 : 202;
    return res.status(httpStatus).json({
      id: instruction.id,
      sessionId: req.params.id,
      status,
      ...(status === 'queued' ? {
        queuePosition: instruction.queuePosition,
        queuedAt: instruction.queuedAt,
      } : {
        deliveredAt: instruction.deliveredAt,
      }),
    });
  } catch (err) {
    return apiError(res, err.statusCode || 500, err.message, err.code);
  }
});

// GET /sessions/:id/messages — message history
router.get('/sessions/:id/messages', (req, res) => {
  const session = getOrchestrationSession(req.params.id);
  if (!session) return apiError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');

  // Instruction queue is our best available history proxy for orchestration sessions.
  // Real message history lives in ~/.claude/projects/<hash>/ JSONL files which are
  // provider-specific. Returning the instruction queue for now.
  const { limit = 50 } = req.query;
  const instructions = getQueuedInstructions(req.params.id).slice(0, parseInt(limit, 10));
  return res.json({ messages: instructions, hasMore: false });
});

// ─── Permission Decisions ────────────────────────────────────────────────────

// POST /sessions/:id/permissions/:requestId/decide
router.post('/sessions/:id/permissions/:requestId/decide', (req, res) => {
  const { decision, reason } = req.body || {};
  if (!decision || !['allow', 'deny'].includes(decision)) {
    return apiError(res, 400, 'decision must be "allow" or "deny"', 'INVALID_DECISION');
  }

  const result = resolveDecision(req.params.requestId, decision, 'linus', reason || '');
  if (!result.ok) {
    const status = result.code === 'ALREADY_DECIDED' ? 409 : 404;
    return apiError(res, status, result.error, result.code);
  }

  return res.json({
    requestId: req.params.requestId,
    sessionId: req.params.id,
    decision,
    decidedAt: new Date().toISOString(),
  });
});

// ─── Event Stream ────────────────────────────────────────────────────────────

// GET /events — SSE stream
// Note: EventSource cannot set auth headers, so we also accept ?token=
router.get('/events', (req, res) => {
  // Auth already handled by orchestrationAuth middleware above,
  // which also accepts ?token= query param for SSE.
  attachSseClient(req, res);
});

export default router;
