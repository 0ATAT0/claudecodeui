/**
 * Instruction Queue Manager
 *
 * - FIFO queue per session; high-priority instructions skip to front
 * - Auto-delivers on session active→idle transition
 * - Max 10 queued instructions per session
 * - Expires queued instructions when a session ends/errors
 */

import crypto from 'crypto';
import {
  enqueueInstruction,
  getQueuedInstructions,
  countQueuedInstructions,
  updateInstructionStatus,
  expireQueuedInstructions,
  getOrchestrationSession,
  updateOrchestrationSession,
} from './db.js';
import { emitEvent } from './eventStream.js';

const MAX_QUEUE_DEPTH = 10;

// Map of sessionId → deliver function (set by sessionController when a session is idle)
const idleDeliveryMap = new Map();

function createInstructionId() {
  return 'instr-' + crypto.randomBytes(8).toString('hex');
}

/**
 * Register a delivery callback for a session.
 * The sessionController calls this with an async function that sends the
 * instruction text to the active provider.
 *
 * @param {string}   sessionId
 * @param {function} deliverFn  async (message: string) => void
 */
function registerDeliveryCallback(sessionId, deliverFn) {
  idleDeliveryMap.set(sessionId, deliverFn);
}

/**
 * Notify the queue that a session has become idle.
 * Dequeues the next instruction (high-priority first) and delivers it.
 */
async function onSessionIdle(sessionId) {
  const instructions = getQueuedInstructions(sessionId);
  if (instructions.length === 0) return;

  const next = instructions[0]; // already sorted by priority + queued_at
  const deliverFn = idleDeliveryMap.get(sessionId);

  if (!deliverFn) {
    console.warn(`[InstructionQueue] No delivery callback registered for session ${sessionId}`);
    return;
  }

  const deliveredAt = new Date().toISOString();
  updateInstructionStatus(next.id, 'delivered', deliveredAt);
  updateOrchestrationSession(sessionId, { status: 'running', last_activity_at: deliveredAt });

  try {
    await deliverFn(next.message);
    emitEvent('session.instruction_delivered', {
      sessionId,
      instructionId: next.id,
      deliveredAt,
    });
  } catch (err) {
    console.error(`[InstructionQueue] Delivery failed for ${next.id}:`, err.message);
  }
}

/**
 * Expire all queued instructions for a session (on end/abort/error).
 */
function onSessionEnded(sessionId) {
  const instructions = getQueuedInstructions(sessionId);
  expireQueuedInstructions(sessionId);
  for (const instr of instructions) {
    emitEvent('session.instruction_expired', { sessionId, instructionId: instr.id });
  }
  idleDeliveryMap.delete(sessionId);
}

/**
 * Enqueue or immediately deliver an instruction.
 *
 * @returns {{ instruction, status: 'delivered'|'queued', queuePosition?: number }}
 */
async function addInstruction(sessionId, message, priority = 'normal') {
  const session = getOrchestrationSession(sessionId);
  if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404, code: 'SESSION_NOT_FOUND' });

  const isIdle = session.status === 'idle';
  const deliverFn = idleDeliveryMap.get(sessionId);

  const instrId = createInstructionId();
  const queuedAt = new Date().toISOString();

  if (isIdle && deliverFn) {
    // Deliver immediately
    const deliveredAt = new Date().toISOString();
    enqueueInstruction({ id: instrId, sessionId, message, priority, queuedAt });
    updateInstructionStatus(instrId, 'delivered', deliveredAt);
    updateOrchestrationSession(sessionId, { status: 'running', last_activity_at: deliveredAt });

    try {
      await deliverFn(message);
      emitEvent('session.instruction_delivered', { sessionId, instructionId: instrId, deliveredAt });
    } catch (err) {
      console.error('[InstructionQueue] Immediate delivery failed:', err.message);
    }

    return {
      instruction: { id: instrId, sessionId, status: 'delivered', deliveredAt },
      status: 'delivered',
    };
  }

  // Queue it
  const queueDepth = countQueuedInstructions(sessionId);
  if (queueDepth >= MAX_QUEUE_DEPTH) {
    throw Object.assign(new Error('Instruction queue full (max 10)'), { statusCode: 429, code: 'QUEUE_FULL' });
  }

  enqueueInstruction({ id: instrId, sessionId, message, priority, queuedAt });

  const position = getQueuedInstructions(sessionId).findIndex(i => i.id === instrId) + 1;
  return {
    instruction: { id: instrId, sessionId, status: 'queued', queuedAt, queuePosition: position },
    status: 'queued',
  };
}

export {
  addInstruction,
  onSessionIdle,
  onSessionEnded,
  registerDeliveryCallback,
};
