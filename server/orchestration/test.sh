#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CloudCLI Orchestration API — smoke tests
#
# Usage:
#   ORCH_KEY=<your-key> JWT=<your-jwt> bash test.sh [BASE_URL]
#
# Defaults:
#   BASE_URL = http://localhost:3000
#   ORCH_KEY = from ORCHESTRATION_API_KEY env
#   JWT      = from JWT env
# ─────────────────────────────────────────────────────────────────────────────

BASE_URL="${1:-http://localhost:3000}"
KEY="${ORCH_KEY:-${ORCHESTRATION_API_KEY:-}}"
TOKEN="${JWT:-}"

if [ -z "$KEY" ] && [ -z "$TOKEN" ]; then
  echo "ERROR: set ORCH_KEY or JWT to authenticate"
  exit 1
fi

# Choose auth header
if [ -n "$KEY" ]; then
  AUTH="Authorization: Bearer $KEY"
else
  AUTH="Authorization: Bearer $TOKEN"
fi

echo "=== CloudCLI Orchestration API Smoke Tests ==="
echo "Base URL: $BASE_URL"
echo ""

ok() { echo "✓ $1"; }
fail() { echo "✗ $1"; }
sep() { echo "--- $1 ---"; }

# ─── Health ──────────────────────────────────────────────────────────────────
sep "Health check"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
[ "$STATUS" = "200" ] && ok "GET /health → 200" || fail "GET /health → $STATUS"

# ─── List Sessions (empty) ───────────────────────────────────────────────────
sep "List Sessions"
RESP=$(curl -s -H "$AUTH" "$BASE_URL/api/orchestration/sessions")
echo "$RESP" | grep -q '"sessions"' && ok "GET /sessions → has sessions key" || fail "GET /sessions → unexpected: $RESP"

# ─── Create Session ──────────────────────────────────────────────────────────
sep "Create Session"
PAYLOAD='{
  "projectPath": "/tmp/test-project",
  "provider": "claude",
  "message": "Say hello and stop.",
  "permissionMode": "bypassPermissions",
  "label": "smoke-test"
}'
RESP=$(curl -s -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$BASE_URL/api/orchestration/sessions")
echo "$RESP"
SESSION_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$SESSION_ID" ] && ok "POST /sessions → session id: $SESSION_ID" || fail "POST /sessions → no id in response"

if [ -z "$SESSION_ID" ]; then
  echo "Cannot continue tests without session ID"
  exit 1
fi

# ─── Get Session ─────────────────────────────────────────────────────────────
sep "Get Session"
RESP=$(curl -s -H "$AUTH" "$BASE_URL/api/orchestration/sessions/$SESSION_ID")
echo "$RESP" | grep -q '"id"' && ok "GET /sessions/:id → has id" || fail "GET /sessions/:id → $RESP"

# ─── Queue Instruction ───────────────────────────────────────────────────────
sep "Queue Instruction"
RESP=$(curl -s -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"message":"Follow-up instruction","priority":"normal"}' \
  "$BASE_URL/api/orchestration/sessions/$SESSION_ID/messages")
echo "$RESP"
echo "$RESP" | grep -q '"status"' && ok "POST /sessions/:id/messages → has status" || fail "POST /sessions/:id/messages → $RESP"

# ─── Get Session Messages ────────────────────────────────────────────────────
sep "Get Messages"
RESP=$(curl -s -H "$AUTH" "$BASE_URL/api/orchestration/sessions/$SESSION_ID/messages")
echo "$RESP" | grep -q '"messages"' && ok "GET /sessions/:id/messages → has messages key" || fail "GET /sessions/:id/messages → $RESP"

# ─── Invalid Permission Decision (should 404 or 400) ─────────────────────────
sep "Permission Decide (non-existent)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"decision":"allow","reason":"test"}' \
  "$BASE_URL/api/orchestration/sessions/$SESSION_ID/permissions/fake-req-id/decide")
[ "$STATUS" = "404" ] && ok "POST /sessions/:id/permissions/fake/decide → 404" || fail "Expected 404, got $STATUS"

# ─── Abort Session ───────────────────────────────────────────────────────────
sep "Abort Session"
RESP=$(curl -s -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"reason":"smoke test cleanup"}' \
  "$BASE_URL/api/orchestration/sessions/$SESSION_ID/abort")
echo "$RESP"
echo "$RESP" | grep -q '"aborted"' && ok "POST /sessions/:id/abort → aborted" || fail "POST /sessions/:id/abort → $RESP"

# ─── 404 on unknown session ───────────────────────────────────────────────────
sep "Unknown Session"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE_URL/api/orchestration/sessions/does-not-exist")
[ "$STATUS" = "404" ] && ok "GET /sessions/does-not-exist → 404" || fail "Expected 404, got $STATUS"

# ─── Auth failure ─────────────────────────────────────────────────────────────
sep "Auth failure"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/orchestration/sessions")
[ "$STATUS" = "401" ] && ok "GET /sessions (no auth) → 401" || fail "Expected 401, got $STATUS"

# ─── SSE stream (quick connect + disconnect) ──────────────────────────────────
sep "SSE Events stream"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 \
  -H "$AUTH" \
  -H "Accept: text/event-stream" \
  "$BASE_URL/api/orchestration/events" 2>/dev/null || true)
# curl exits non-zero on timeout, but we just need to see headers arrive
[ "$STATUS" = "200" ] && ok "GET /events → 200" || echo "  (SSE timed-out as expected — got $STATUS)"

echo ""
echo "=== Done ==="
