/**
 * OC Notification Bridge
 *
 * Listens for CloudCLI orchestration events and pushes actionable ones
 * to Linus's OC session via sessions_send (/tools/invoke).
 *
 * Uses the origin_session_key stored per CloudCLI session to route
 * notifications to the correct OC session (the one that launched the run).
 *
 * Events forwarded:
 *   session.idle           — session finished current task, waiting for instruction
 *   session.error          — something broke
 *   session.ended          — session terminated
 *   session.context_threshold — context nearing limit (93%/97%)
 */

import { EVENT_BUS } from './eventStream.js';
import { getOrchestrationSession } from './db.js';

// OC Gateway config — same instance Arbiter uses
const OC_TOOLS_INVOKE_URL = process.env.OPENCLAW_TOOLS_INVOKE_URL || 'http://localhost:18789/tools/invoke';
const OC_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

// Events worth pushing (permission_requested is handled by Arbiter, not here)
const NOTIFY_EVENTS = new Set([
  'session.idle',
  'session.error',
  'session.ended',
  'session.context_threshold',
]);

/**
 * Send a message to an OC session via /tools/invoke sessions_send.
 */
async function sendToOcSession(targetSessionKey, message) {
  if (!OC_GATEWAY_TOKEN) {
    console.warn('[ocNotify] skipped: OPENCLAW_GATEWAY_TOKEN missing');
    return;
  }
  if (!targetSessionKey) {
    console.warn('[ocNotify] skipped: no target session key');
    return;
  }

  const body = {
    tool: 'sessions_send',
    sessionKey: targetSessionKey,
    args: {
      sessionKey: targetSessionKey,
      message,
      timeoutSeconds: 0,
    },
  };

  try {
    const res = await fetch(OC_TOOLS_INVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OC_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[ocNotify] sessions_send failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[ocNotify] sessions_send failed: ${err.message}`);
  }
}

/**
 * Format an event into a concise notification message.
 * Keep payloads minimal — no file paths, no technical internals.
 */
function formatNotification(event, data) {
  const sid = data.sessionId ? data.sessionId.slice(0, 8) : '???';

  switch (event) {
    case 'session.idle':
      return `CloudCLI session \`${sid}\` is idle (${data.reason || 'task complete'}). Check status and send next instruction.`;

    case 'session.error':
      return `CloudCLI session \`${sid}\` error: ${data.error || 'unknown'}. ${data.recoverable ? 'Recoverable.' : 'May need relaunch.'}`;

    case 'session.ended':
      return `CloudCLI session \`${sid}\` ended (${data.reason || 'unknown'}).`;

    case 'session.context_threshold': {
      const pct = data.percent ? `${data.percent}%` : `${data.level || 'high'}`;
      return `CloudCLI session \`${sid}\` context at ${pct}. Instruct handover note now if not already written.`;
    }

    default:
      return `CloudCLI event \`${event}\` for session \`${sid}\`.`;
  }
}

/**
 * Start listening for orchestration events and forwarding to OC.
 */
function startOcNotifyBridge() {
  if (!OC_GATEWAY_TOKEN) {
    console.warn('[ocNotify] bridge disabled: OPENCLAW_GATEWAY_TOKEN not set');
    return;
  }

  console.log('[ocNotify] bridge started — forwarding lifecycle events to OC');

  EVENT_BUS.on('event', ({ event, data }) => {
    if (!NOTIFY_EVENTS.has(event)) return;
    if (!data?.sessionId) return;

    // Look up origin session key from the CloudCLI session record
    const session = getOrchestrationSession(data.sessionId);
    const targetKey = session?.origin_session_key;

    if (!targetKey) {
      console.warn(`[ocNotify] ${event} for ${data.sessionId}: no origin_session_key, skipping`);
      return;
    }

    const message = formatNotification(event, data);
    sendToOcSession(targetKey, message).then(() => {
      console.log(`[ocNotify] ${event} for ${data.sessionId.slice(0, 8)} → sent to OC`);
    }).catch(err => {
      console.warn(`[ocNotify] failed to notify for ${event}: ${err.message}`);
    });
  });
}

export { startOcNotifyBridge };
