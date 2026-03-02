/**
 * SSE Event Manager
 *
 * - Global EventEmitter bus for all orchestration events
 * - Circular event buffer: 1000 events / 5 min for Last-Event-ID replay
 * - 30-second heartbeat per connected client
 * - Supports optional sessionId filter
 */

import { EventEmitter } from 'events';

const EVENT_BUS = new EventEmitter();
EVENT_BUS.setMaxListeners(200);

const BUFFER_MAX_EVENTS = parseInt(process.env.ORCH_BUFFER_MAX_EVENTS, 10) || 1000;
const BUFFER_MAX_MS     = parseInt(process.env.ORCH_BUFFER_MAX_MS,     10) || 5 * 60 * 1000;
const HEARTBEAT_MS      = 30_000;

// Shared circular buffer of { id, event, data, ts }
const eventBuffer = [];
let globalEventId = 0;

function bufferEvent(event, data) {
  const id = ++globalEventId;
  const ts = Date.now();
  eventBuffer.push({ id, event, data, ts });

  // Trim by count
  while (eventBuffer.length > BUFFER_MAX_EVENTS) eventBuffer.shift();
  // Trim by age
  const cutoff = ts - BUFFER_MAX_MS;
  while (eventBuffer.length > 0 && eventBuffer[0].ts < cutoff) eventBuffer.shift();

  return id;
}

function getMissedEvents(lastEventId, sessionId) {
  const fromId = parseInt(lastEventId, 10) || 0;
  return eventBuffer.filter(e => {
    if (e.id <= fromId) return false;
    if (sessionId && e.data?.sessionId && e.data.sessionId !== sessionId) return false;
    return true;
  });
}

/**
 * Emit an orchestration event onto the bus (and into the buffer).
 * @param {string} event  - Event type name, e.g. 'session.started'
 * @param {object} data   - Payload (must be JSON-serialisable)
 */
function emitEvent(event, data) {
  const id = bufferEvent(event, data);
  EVENT_BUS.emit('event', { id, event, data });
}

/**
 * Attach an SSE response to the event stream.
 * Called by the router for GET /api/orchestration/events
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function attachSseClient(req, res) {
  const filterSessionId = req.query.sessionId || null;
  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId || null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx passthrough
  res.flushHeaders();

  function write(id, event, data) {
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }

  // Replay missed events
  if (lastEventId) {
    const missed = getMissedEvents(lastEventId, filterSessionId);
    for (const e of missed) write(e.id, e.event, e.data);
  }

  // Send initial heartbeat
  write(globalEventId, 'heartbeat', { timestamp: new Date().toISOString(), activeSessions: 0 });

  // Live listener
  const onEvent = ({ id, event, data }) => {
    if (filterSessionId && data?.sessionId && data.sessionId !== filterSessionId) return;
    write(id, event, data);
  };
  EVENT_BUS.on('event', onEvent);

  // Heartbeat timer
  const heartbeatTimer = setInterval(() => {
    write(globalEventId, 'heartbeat', { timestamp: new Date().toISOString() });
  }, HEARTBEAT_MS);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeatTimer);
    EVENT_BUS.off('event', onEvent);
  });
}

export { emitEvent, attachSseClient, EVENT_BUS };
