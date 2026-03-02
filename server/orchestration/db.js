/**
 * Orchestration DB module
 * Adds 3 new tables to the existing CloudCLI SQLite database:
 *   - orchestration_sessions
 *   - instruction_queue
 *   - pending_permissions
 *
 * Uses the existing `db` instance from server/database/db.js (better-sqlite3).
 */

import { db } from '../database/db.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS orchestration_sessions (
    id               TEXT PRIMARY KEY,
    provider         TEXT NOT NULL DEFAULT 'claude',
    project_path     TEXT NOT NULL,
    model            TEXT,
    label            TEXT,
    status           TEXT NOT NULL DEFAULT 'running',
    permission_mode  TEXT NOT NULL DEFAULT 'webhook',
    started_at       TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    ended_at         TEXT,
    context_used     INTEGER DEFAULT 0,
    context_total    INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS instruction_queue (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    message      TEXT NOT NULL,
    priority     TEXT NOT NULL DEFAULT 'normal',
    status       TEXT NOT NULL DEFAULT 'queued',
    queued_at    TEXT NOT NULL,
    delivered_at TEXT,
    FOREIGN KEY (session_id) REFERENCES orchestration_sessions(id)
  );

  CREATE TABLE IF NOT EXISTS pending_permissions (
    request_id        TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    tool              TEXT NOT NULL,
    input_json        TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    decision_source   TEXT,
    decision_reason   TEXT,
    requested_at      TEXT NOT NULL,
    decided_at        TEXT,
    expires_at        TEXT NOT NULL,
    callback_attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES orchestration_sessions(id)
  );
`;

function initOrchestrationDb() {
  try {
    db.exec(SCHEMA_SQL);
    console.log('[Orchestration] DB schema initialised');
  } catch (err) {
    console.error('[Orchestration] Failed to init DB schema:', err.message);
    throw err;
  }
}

// ─── orchestration_sessions helpers ─────────────────────────────────────────

function createOrchestrationSession(session) {
  const stmt = db.prepare(`
    INSERT INTO orchestration_sessions
      (id, provider, project_path, model, label, status, permission_mode, started_at, last_activity_at)
    VALUES
      (@id, @provider, @project_path, @model, @label, @status, @permission_mode, @started_at, @last_activity_at)
  `);
  stmt.run({
    id: session.id,
    provider: session.provider ?? 'claude',
    project_path: session.projectPath,
    model: session.model ?? null,
    label: session.label ?? null,
    status: session.status ?? 'running',
    permission_mode: session.permissionMode ?? 'webhook',
    started_at: session.startedAt ?? new Date().toISOString(),
    last_activity_at: session.startedAt ?? new Date().toISOString(),
  });
}

function getOrchestrationSession(id) {
  return db.prepare('SELECT * FROM orchestration_sessions WHERE id = ?').get(id);
}

function listOrchestrationSessions({ status, provider, projectPath, limit = 20 } = {}) {
  let query = 'SELECT * FROM orchestration_sessions WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (provider) {
    query += ' AND provider = ?';
    params.push(provider);
  }
  if (projectPath) {
    query += ' AND project_path = ?';
    params.push(projectPath);
  }

  query += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

function updateOrchestrationSession(id, fields) {
  const allowed = ['status', 'last_activity_at', 'ended_at', 'context_used', 'context_total', 'label'];
  const setClauses = [];
  const params = [];

  for (const key of allowed) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }

  if (setClauses.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE orchestration_sessions SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

// ─── instruction_queue helpers ───────────────────────────────────────────────

function enqueueInstruction(instr) {
  db.prepare(`
    INSERT INTO instruction_queue (id, session_id, message, priority, status, queued_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
  `).run(instr.id, instr.sessionId, instr.message, instr.priority ?? 'normal', instr.queuedAt ?? new Date().toISOString());
}

function getQueuedInstructions(sessionId) {
  return db.prepare(`
    SELECT * FROM instruction_queue
    WHERE session_id = ? AND status = 'queued'
    ORDER BY
      CASE priority WHEN 'high' THEN 0 ELSE 1 END ASC,
      queued_at ASC
  `).all(sessionId);
}

function countQueuedInstructions(sessionId) {
  return db.prepare(`SELECT COUNT(*) as n FROM instruction_queue WHERE session_id = ? AND status = 'queued'`).get(sessionId).n;
}

function updateInstructionStatus(id, status, deliveredAt) {
  db.prepare(`UPDATE instruction_queue SET status = ?, delivered_at = ? WHERE id = ?`).run(status, deliveredAt ?? null, id);
}

function expireQueuedInstructions(sessionId) {
  db.prepare(`UPDATE instruction_queue SET status = 'expired' WHERE session_id = ? AND status = 'queued'`).run(sessionId);
}

// ─── pending_permissions helpers ─────────────────────────────────────────────

function createPendingPermission(perm) {
  db.prepare(`
    INSERT INTO pending_permissions
      (request_id, session_id, tool, input_json, status, requested_at, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    perm.requestId,
    perm.sessionId,
    perm.tool,
    typeof perm.input === 'string' ? perm.input : JSON.stringify(perm.input),
    perm.requestedAt ?? new Date().toISOString(),
    perm.expiresAt,
  );
}

function getPendingPermission(requestId) {
  return db.prepare('SELECT * FROM pending_permissions WHERE request_id = ?').get(requestId);
}

function getPendingPermissionsForSession(sessionId) {
  return db.prepare(`SELECT * FROM pending_permissions WHERE session_id = ? AND status = 'pending'`).all(sessionId);
}

function updatePermissionDecision(requestId, { status, source, reason, decidedAt }) {
  db.prepare(`
    UPDATE pending_permissions
    SET status = ?, decision_source = ?, decision_reason = ?, decided_at = ?
    WHERE request_id = ?
  `).run(status, source ?? null, reason ?? null, decidedAt ?? new Date().toISOString(), requestId);
}

function incrementPermissionCallbackAttempts(requestId) {
  db.prepare(`UPDATE pending_permissions SET callback_attempts = callback_attempts + 1 WHERE request_id = ?`).run(requestId);
}

export {
  initOrchestrationDb,
  // sessions
  createOrchestrationSession,
  getOrchestrationSession,
  listOrchestrationSessions,
  updateOrchestrationSession,
  // instructions
  enqueueInstruction,
  getQueuedInstructions,
  countQueuedInstructions,
  updateInstructionStatus,
  expireQueuedInstructions,
  // permissions
  createPendingPermission,
  getPendingPermission,
  getPendingPermissionsForSession,
  updatePermissionDecision,
  incrementPermissionCallbackAttempts,
};
