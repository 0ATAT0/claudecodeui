/**
 * Context Monitor
 *
 * Tracks token usage per session and emits threshold events.
 * Thresholds: 60% (info), 80% (warning), 93% (critical), 97% (emergency)
 * Each threshold fires at most once per session (de-duplicated).
 */

import { emitEvent } from './eventStream.js';
import { updateOrchestrationSession } from './db.js';

const THRESHOLDS = [
  { percent: 60, level: 'info' },
  { percent: 80, level: 'warning' },
  { percent: 93, level: 'critical' },
  { percent: 97, level: 'emergency' },
];

// sessionId → Set<percent> of already-fired thresholds
const firedThresholds = new Map();

/**
 * Record updated token usage for a session.
 * Fires SSE events for any newly-crossed thresholds.
 *
 * @param {string} sessionId
 * @param {number} used   - tokens used
 * @param {number} total  - context window size
 */
function updateContextUsage(sessionId, used, total) {
  if (!total || total === 0) return;

  // Persist to DB
  updateOrchestrationSession(sessionId, { context_used: used, context_total: total });

  const percent = (used / total) * 100;
  if (!firedThresholds.has(sessionId)) firedThresholds.set(sessionId, new Set());
  const fired = firedThresholds.get(sessionId);

  for (const { percent: threshold, level } of THRESHOLDS) {
    if (percent >= threshold && !fired.has(threshold)) {
      fired.add(threshold);
      emitEvent('session.context_threshold', {
        sessionId,
        percent: threshold,
        actualPercent: Math.round(percent * 10) / 10,
        used,
        total,
        level,
      });
    }
  }
}

/**
 * Clear threshold state when a session ends (so a resumed session starts fresh).
 */
function clearSessionThresholds(sessionId) {
  firedThresholds.delete(sessionId);
}

export { updateContextUsage, clearSessionThresholds };
