#!/usr/bin/env bash
# smoke.sh — LIVE end-to-end verification against a real server instance.
#
#   1. boots the server on a temp DB + free port (bots ON, drift OFF)
#   2. proves the bot ladders are quoting and prices are valid ladder ticks
#   3. registers two customers + the admin, tops up the faucet
#   4. admin creates a fresh market (no bot ladders there → deterministic)
#   5. alice backs, bob lays → they match at the resting price
#   6. admin settles → both wallets reflect the pot minus commission
#   7. checks the guards (401 / 403 foreign origin) and the static assets
#
# Cleanup kills ONLY the PID this script started. No pkill, no name matching.
# Run: ./tests/smoke.sh
set -uo pipefail

cd "$(dirname "$0")/.."
# A free port instead of a fixed one: a hard-coded 7899 collides with any
# concurrently running suite or dev server and the whole smoke run dies at
# boot. Same discovery as ui_test.mjs — bind :0, read back the port the OS
# chose, release, let the server re-bind. An explicit SMOKE_PORT still wins
# for targeted debugging against a known instance.
if [ -n "${SMOKE_PORT:-}" ]; then
  PORT="$SMOKE_PORT"
else
  PORT=$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})') \
    || { echo "  FAIL could not discover a free port"; exit 1; }
fi
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
PID=""
FAILED=0

cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { echo "  ok   $1" >&2; }
bad()  { echo "  FAIL $1" >&2; FAILED=1; }
check(){ # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2' want '$3'"; fi
}
# pick <dotted.path> — reads JSON on stdin, prints the value (objects as JSON)
pick() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v[k];console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "→ booting server on :$PORT (temp db, bots on, drift off)"
DB_PATH="$TMP/ob.db" PORT="$PORT" DRIFT_ENABLED=false ADMIN_PASSWORD=smoke-admin-password DEMO_PASSWORD=smoke-demo-password node --no-warnings server.js >"$TMP/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  curl -sf --max-time 1 "$BASE/api/sports" -o /dev/null 2>/dev/null && break
  sleep 0.25
done
if ! curl -sf --max-time 2 "$BASE/api/sports" -o /dev/null; then
  echo "  FAIL server did not come up; log:"; cat "$TMP/server.log"; exit 1
fi
ok "server up"

# ── 1. catalogue + bot liquidity ───────────────────────────────────────────
SPORTS=$(curl -s "$BASE/api/sports")
check "sports seeded" "$(echo "$SPORTS" | pick sports.0.name)" "Football"
EV=$(curl -s "$BASE/api/events?sport=football")
LEVELS=$(echo "$EV" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);const sel=j.events[0].markets[0].selections[0];console.log(sel.back.length+sel.lay.length)})')
if [ "$LEVELS" -ge 2 ]; then ok "bot ladders quoting ($LEVELS levels on the first runner)"; else bad "bot ladders missing (levels=$LEVELS)"; fi
TICK=$(echo "$EV" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);const lv=j.events[0].markets[0].selections[0];const p=(lv.back[0]||lv.lay[0]).price;console.log(Number(p).toFixed(2))})')
node -e 'const {snapToTick}=require("./lib/odds");const p=Number(process.argv[1]);if(Math.abs(snapToTick(p)-p)>1e-9){console.error("not a ladder tick:",p);process.exit(1)}' "$TICK" \
  && ok "quoted price is a valid ladder tick ($TICK)" || bad "quoted price off-ladder: $TICK"

# ── 2. customers + admin ───────────────────────────────────────────────────
check "alice registers" "$(status -c "$TMP/alice.jar" -X POST "$BASE/api/auth/register" -H 'content-type: application/json' -d '{"username":"smoke_alice","password":"secret1"}')" "201"
check "bob registers"   "$(status -c "$TMP/bob.jar"   -X POST "$BASE/api/auth/register" -H 'content-type: application/json' -d '{"username":"smoke_bob","password":"secret2"}')" "201"
check "admin logs in"   "$(status -c "$TMP/admin.jar" -X POST "$BASE/api/auth/login"   -H 'content-type: application/json' -d '{"username":"admin","password":"smoke-admin-password"}')" "200"
check "alice 401 pre-auth" "$(status "$BASE/api/me")" "401"
check "foreign origin rejected" "$(status -b "$TMP/alice.jar" -X POST "$BASE/api/wallet/deposit" -H 'content-type: application/json' -H 'Origin: https://evil.example' -d '{"amount_cents":100}')" "403"

curl -s -b "$TMP/alice.jar" -X POST "$BASE/api/wallet/deposit" -H 'content-type: application/json' -d '{"amount_cents":50000}' -o /dev/null
curl -s -b "$TMP/bob.jar"   -X POST "$BASE/api/wallet/deposit" -H 'content-type: application/json' -d '{"amount_cents":50000}' -o /dev/null

# ── 3. admin creates a market (no bots quote here → deterministic matching) ─
SPID=$(echo "$SPORTS" | pick sports.0.id)
post_admin() { # post_admin <path> <json> — echoes body, fails loudly on non-2xx
  local code
  code=$(curl -s -b "$TMP/admin.jar" -o "$TMP/last.json" -w '%{http_code}' -X POST "$BASE$1" -H 'content-type: application/json' -d "$2")
  if [ "${code:0:1}" != "2" ]; then
    bad "admin POST $1 → HTTP $code $(cat "$TMP/last.json")"
  fi
  cat "$TMP/last.json"
}
post_admin /api/admin/events "{\"sport_id\":$SPID,\"name\":\"Smoke Test FC vs Smoke Test United\",\"starts_at\":\"2030-01-01 12:00\"}" >"$TMP/event.json"
EVID=$(pick event.id <"$TMP/event.json")
post_admin /api/admin/markets "{\"event_id\":$EVID,\"name\":\"Smoke Match Odds\"}" >"$TMP/market.json"
MID=$(pick market.id <"$TMP/market.json")
# Two runners WITHOUT a fair price: the bot never quotes a fair-priceless
# runner, so the only liquidity in this market is customer-to-customer and
# the match below is deterministic. (The seeded market above already proves
# the bots quote.)
post_admin /api/admin/selections "{\"market_id\":$MID,\"name\":\"Smoke FC\"}" >/dev/null
post_admin /api/admin/selections "{\"market_id\":$MID,\"name\":\"Smoke United\"}" >/dev/null
BOOK=$(curl -s "$BASE/api/markets/$MID/book")
SEL1=$(echo "$BOOK" | pick book.0.selection_id)
EMPTY_LEVELS=$(echo "$BOOK" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log(j.book.reduce((a,b)=>a+b.back.length+b.lay.length,0))})')
check "a fair-priceless runner gets no bot ladder" "$EMPTY_LEVELS" "0"
ok "admin created event $EVID -> market $MID with runner $SEL1"

# A market created WITH a fair price must be quoted immediately (the desk
# should never publish a tradable market with an empty book).
post_admin /api/admin/selections "{\"market_id\":$MID,\"name\":\"Smoke Quoted\",\"fair_price\":2.5}" >/dev/null
QUOTED=$(curl -s "$BASE/api/markets/$MID/book" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);const q=j.book.find(x=>x.name==="Smoke Quoted");console.log(q.back.length+q.lay.length)})')
if [ "$QUOTED" -ge 2 ]; then ok "fair-priced runner quoted immediately ($QUOTED levels)"; else bad "fair-priced runner not quoted (levels=$QUOTED)"; fi

# ── 4. the trade: alice rests a back, bob's lay sweeps it ───────────────────
O1=$(curl -s -b "$TMP/alice.jar" -X POST "$BASE/api/orders" -H 'content-type: application/json' \
  -d "{\"selection_id\":$SEL1,\"side\":\"back\",\"price\":2.5,\"stake_cents\":10000}")
check "alice back rests (market has no bots)" "$(echo "$O1" | pick order.status)" "open"
check "alice matched nothing yet"           "$(echo "$O1" | pick order.matched_cents)" "0"
O2=$(curl -s -b "$TMP/bob.jar" -X POST "$BASE/api/orders" -H 'content-type: application/json' \
  -d "{\"selection_id\":$SEL1,\"side\":\"lay\",\"price\":2.5,\"stake_cents\":10000}")
check "bob lay fully matches"        "$(echo "$O2" | pick order.status)" "fully_matched"
check "matched at the resting price" "$(echo "$O2" | pick fills.0.price)" "2.5"
POS=$(curl -s -b "$TMP/alice.jar" "$BASE/api/positions")
check "alice if-win P&L on her runner" "$(echo "$POS" | pick positions.0.pnl_if_win.0.pnl_cents)" "15000"

# ── 5. settlement: pot to the winner, commission on net winnings ────────────
SET=$(curl -s -b "$TMP/admin.jar" -X POST "$BASE/api/admin/markets/$MID/settle" -H 'content-type: application/json' \
  -d "{\"winner_selection_id\":$SEL1}")
check "market settled"        "$(echo "$SET" | pick market.status)" "settled"
check "winner recorded"       "$(echo "$SET" | pick market.winner_selection_id)" "$SEL1"
AW=$(curl -s -b "$TMP/alice.jar" "$BASE/api/wallet")
BW=$(curl -s -b "$TMP/bob.jar" "$BASE/api/wallet")
ALICE_BAL=$(echo "$AW" | pick balance_cents)
BOB_BAL=$(echo "$BW" | pick balance_cents)
# alice: 50000 + 15000 profit − round(15000*0.025)=375
check "alice wallet after settlement" "$(echo "$AW" | pick balance_cents)" "64625"
check "alice escrow released"         "$(echo "$AW" | pick frozen_cents)" "0"
# bob lost his liability (2.5−1)*10000 = 15000
check "bob wallet after settlement"   "$(echo "$BW" | pick balance_cents)" "35000"
ST=$(curl -s -b "$TMP/alice.jar" "$BASE/api/settlements")
check "alice settlement P&L"     "$(echo "$ST" | pick settlements.0.pnl_cents)" "15000"
check "alice commission charged" "$(echo "$ST" | pick settlements.0.commission_cents)" "375"
check "settled market is frozen" "$(status -b "$TMP/alice.jar" -X POST "$BASE/api/orders" -H 'content-type: application/json' \
  -d "{\"selection_id\":$SEL1,\"side\":\"back\",\"price\":2.5,\"stake_cents\":10000}")" "409"

# ── 6. frontend assets ─────────────────────────────────────────────────────
# The app's 1,891-line app.js was split into seven modules under /js/. They are
# listed individually because a partial split is the exact failure mode worth
# catching: the page loads, one view is blank, and nothing in the server log
# says why.
for asset in / /ladder.js /js/core.js /js/shell.js /js/nav.js /js/board.js \
             /js/slip.js /js/views.js /js/boot.js /admin.js /admin-risk.js \
             /style.css; do
  check "serves $asset" "$(status "$BASE$asset")" "200"
done

# The old single file must be GONE, not merely unused. A stale
# <script src="/app.js"> in a template would 404 in the browser with nothing in
# the server log, and the page would come up half-rendered.
check "no stale /app.js left behind" "$(status "$BASE/app.js")" "404"

# ── 7. integrity: the wallet is clean integer cents, never NaN or float ────
# The amount was already pinned in section 5; this checks the TYPE. A NaN
# anywhere in the money path surfaces as null (JSON.stringify(NaN) → null)
# or as an invalid-JSON token that JSON.parse throws on — either way the
# check below fails instead of silently rendering "NaN" in the dashboard.
curl -s -b "$TMP/alice.jar" "$BASE/api/wallet" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const j = JSON.parse(s);
    if (!Number.isInteger(j.balance_cents) || !Number.isInteger(j.frozen_cents)) {
      console.error("not integer cents:", j.balance_cents, j.frozen_cents);
      process.exit(1);
    }
  });' \
  && ok "no NaN leaked into the wallet (balance + frozen are integers)" \
  || bad "wallet carries a non-integer value"

# ── 8. conservation: the only money that left the two players is commission ─
TOTAL=$(node -e '
const { execFileSync } = require("child_process");
const a = Number(process.argv[1]), b = Number(process.argv[2]);
process.stdout.write(String(a + b));' "$ALICE_BAL" "$BOB_BAL")
# alice + bob started with 50000 each; 100000 + net(-375) = 99625
check "money conserved (players 100000 - commission 375)" "$TOTAL" "99625"
check "all escrow released (both frozen 0)" "$(echo "$AW" | pick frozen_cents)$(echo "$BW" | pick frozen_cents)" "00"
# settled market must leave no open orders behind
check "no open orders after settlement" "$(curl -s -b "$TMP/alice.jar" "$BASE/api/orders" | pick orders)" "[]"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "smoke: ALL CHECKS PASSED"
else
  echo "smoke: FAILURES PRESENT"
fi
exit "$FAILED"
