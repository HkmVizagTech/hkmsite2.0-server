#!/usr/bin/env bash
# Isolated local test environment for the Mongo->Postgres port.
#   scripts/parity/env.sh up <name> <basePort>   baseline(Mongo) on <basePort>, new(Postgres) on <basePort>+1
#   scripts/parity/env.sh restart <name>         restart both servers (after code edits)
#   scripts/parity/env.sh reset <name>           drop and recreate both databases from the pristine Mongo copy
#   scripts/parity/env.sh down <name>
#   MOCKS=1 scripts/parity/env.sh up|restart|reset ...   also fake every outside service (scripts/parity/mocks/README.md)
# Never loads the real .env: servers get a sanitized env (no live Razorpay/DCC/WhatsApp keys, jobs off).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCAL="$ROOT/../.localdb"
PGBIN=/Library/PostgreSQL/18/bin
cmd="${1:?cmd}"; name="${2:?name}"; dir="$LOCAL/envs/$name"
MDB="m_$name"; PDB="pg_$name"

write_env() {
  local port="$1" file="$2" extra="$3"
  { cat "$LOCAL/env.common"; echo "PORT=$port"; echo "$extra"; } > "$file"
}
# MOCKS=1: outbound HTTP goes to the recording fakes in scripts/parity/mocks (see its README).
mock_env() {
  local tag="$1"
  [ "${MOCKS:-0}" = "1" ] || return 0
  if [ "${MOCK_WIPE:-0}" = "1" ] || [ ! -f "$dir/$tag-mock-state.json" ]; then
    echo '{}' > "$dir/$tag-mock-state.json"; rm -f "$dir/$tag-mock-state.store.json"; : > "$dir/$tag-outbound.jsonl"
  fi
  printf '%s\n' \
    "NODE_OPTIONS=--import=$ROOT/scripts/parity/mocks/preload.mjs" \
    "MOCK_STATE=$dir/$tag-mock-state.json" "MOCK_LOG=$dir/$tag-outbound.jsonl" \
    DCC_API_KEY=mock-dcc-key DCC_API_URL=https://dcc.mock.test/api/socialmedia/addDonation \
    WAPI_TOKEN=mock-wapi-token GUPSHUP_API_KEY=mock-gupshup-key GUPSHUP_APP_NAME=MockApp \
    META_PIXEL_ID=100000000000001 META_CAPI_ACCESS_TOKEN=mock-meta-token \
    R2_ACCOUNT_ID=mockaccount R2_ACCESS_KEY_ID=mock-r2-key R2_SECRET_ACCESS_KEY=mock-r2-secret \
    R2_BUCKET_NAME=mock-bucket R2_PUBLIC_URL=https://pub-mock.r2.dev \
    DRM_API_URL=https://drm.mock.test DRM_INTERNAL_SECRET=mock-drm-secret \
    DELHIVERY_TRACKING_API_KEY=mock-delhivery-key DTDC_TRACKING_API_KEY=mock-dtdc-key \
    BLUEDART_API_KEY=mock-bluedart-key BLUEDART_LOGIN_ID=MOCKLOGIN \
    CLOUDINARY_CLOUD_NAME=mock CLOUDINARY_API_KEY=mock-cloudinary-key CLOUDINARY_API_SECRET=mock-cloudinary-secret \
    RECEIPT_WHATSAPP_PROVIDER="${RECEIPT_WHATSAPP_PROVIDER:-gupshup}"
}
start_servers() {
  local base; base=$(cat "$dir/port")
  local -a mock_b=() mock_n=()
  if [ "${MOCKS:-0}" = "1" ]; then
    while IFS= read -r l; do mock_b+=("$l"); done < <(mock_env baseline)
    while IFS= read -r l; do mock_n+=("$l"); done < <(mock_env new)
  fi
  (cd "$LOCAL/baseline"; env -i PATH="$PATH" HOME="$HOME" ENV_FILE="$dir/env.mongo" ${mock_b[@]+"${mock_b[@]}"} nohup node index.js < /dev/null > "$dir/baseline.log" 2>&1 & echo $! > "$dir/baseline.pid")
  (cd "$ROOT"; env -i PATH="$PATH" HOME="$HOME" ENV_FILE="$dir/env.pg" ${mock_n[@]+"${mock_n[@]}"} nohup node index.js < /dev/null > "$dir/new.log" 2>&1 & echo $! > "$dir/new.pid")
  for i in $(seq 1 30); do
    curl -sf "localhost:$base/health" >/dev/null && curl -sf "localhost:$((base+1))/health" >/dev/null && { echo "up: baseline :$base  new :$((base+1))"; return; }
    sleep 1
  done
  echo "servers did not become healthy; see $dir/*.log"; tail -5 "$dir/new.log"; exit 1
}
stop_servers() {
  for f in baseline new; do [ -f "$dir/$f.pid" ] && kill "$(cat "$dir/$f.pid")" 2>/dev/null || true; rm -f "$dir/$f.pid"; done
  if [ -f "$dir/port" ]; then
    base=$(cat "$dir/port")
    for p in "$base" "$((base+1))"; do lsof -ti ":$p" 2>/dev/null | xargs kill 2>/dev/null || true; done
  fi
  sleep 1
}
make_dbs() {
  mongosh --quiet --port 27018 "$MDB" --eval 'db.dropDatabase()' >/dev/null
  mongodump --port 27018 --db test --archive --quiet | mongorestore --port 27018 --archive --nsFrom 'test.*' --nsTo "$MDB.*" --quiet
  "$PGBIN/dropdb" -h localhost -p 5433 -U hkm --if-exists "$PDB"
  "$PGBIN/createdb" -h localhost -p 5433 -U hkm "$PDB"
  "$PGBIN/psql" -h localhost -p 5433 -U hkm -d "$PDB" -v ON_ERROR_STOP=1 -q -f "$ROOT/docs/postgres-migration/schema.sql"
  SRC_MONGO_URI="mongodb://127.0.0.1:27018/$MDB" DEST_PG_URL="postgres://hkm@localhost:5433/$PDB" node "$ROOT/scripts/migrate-mongo-to-pg.js" >/dev/null
}

case "$cmd" in
  up)
    base="${3:?basePort}"; mkdir -p "$dir"; echo "$base" > "$dir/port"
    write_env "$base" "$dir/env.mongo" "MONGO_URI=mongodb://127.0.0.1:27018/$MDB"
    write_env "$((base+1))" "$dir/env.pg" "DATABASE_URL=postgres://hkm@localhost:5433/$PDB"
    MOCK_WIPE=1; make_dbs; start_servers
    echo "mongo db: $MDB   pg db: $PDB   logs: $dir"
    echo "SRC_MONGO_URI=mongodb://127.0.0.1:27018/$MDB DATABASE_URL=postgres://hkm@localhost:5433/$PDB"
    ;;
  restart) stop_servers; start_servers ;;
  reset) stop_servers; MOCK_WIPE=1; make_dbs; start_servers ;;
  down)
    stop_servers
    mongosh --quiet --port 27018 "$MDB" --eval 'db.dropDatabase()' >/dev/null || true
    "$PGBIN/dropdb" -h localhost -p 5433 -U hkm --if-exists "$PDB"
    rm -rf "$dir"; echo "down $name" ;;
  *) echo "unknown cmd"; exit 1 ;;
esac
