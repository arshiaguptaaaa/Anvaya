#!/bin/bash
# Adds secret variables to the Cloud Run service with a MERGE-ONLY update (existing variables are kept).
# Values are typed with hidden input, never echoed, never passed on a command line, and the temporary
# file holding them is private (0600) and deleted on exit. Nothing is printed except variable NAMES.
#   bash scripts/cloudrun-set-secrets.sh                  (all four)
#   bash scripts/cloudrun-set-secrets.sh RESEND_API_KEY   (only the names given)
set -euo pipefail
G="${GCLOUD:-$HOME/google-cloud-sdk/bin/gcloud}"
PROJECT=zinc-reason-491008-d0 REGION=us-east1 SERVICE=anvaya
ALLOWED=" DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY RESEND_API_KEY "
if [ $# -gt 0 ]; then NAMES=("$@"); else NAMES=(DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY RESEND_API_KEY); fi
for N in "${NAMES[@]}"; do [[ "$ALLOWED" == *" $N "* ]] || { echo "Unknown variable: $N"; exit 1; }; done
echo "Will update ONLY: ${NAMES[*]} (every other variable is kept as is)"

echo "Account: $("$G" config get-value account 2>/dev/null)   Project: $PROJECT   Service: $SERVICE ($REGION)"
LATEST=$("$G" run services describe $SERVICE --project $PROJECT --region $REGION --format='value(status.latestReadyRevisionName)')
echo "Latest revision before update: $LATEST"
echo "Variables on it: $("$G" run revisions describe "$LATEST" --project $PROJECT --region $REGION --format='value(spec.containers[0].env[].name)' | tr ';' ' ')"
echo

umask 077
TMP=$(mktemp -t anvaya-flags)
trap 'rm -f "$TMP"' EXIT

check() { # name value → error text or empty
  case "$1" in
    DATABASE_URL) [[ "$2" == postgres*://*@*:6543/* ]] || echo "should start with postgres:// and use port 6543 (Transaction pooler)";;
    SUPABASE_URL) [[ "$2" =~ ^https://[a-z0-9]+\.supabase\.co/?$ ]] || echo "should look like https://xxxx.supabase.co";;
    SUPABASE_SERVICE_ROLE_KEY) [ ${#2} -ge 40 ] || echo "looks too short";;
    RESEND_API_KEY) [[ "$2" == re_* ]] || echo "should start with re_";;
  esac
}

for N in "${NAMES[@]}"; do
  while true; do
    read -rsp "Paste $N (hidden), then Enter: " VAL; echo
    VAL="${VAL#"${VAL%%[![:space:]]*}"}"; VAL="${VAL%"${VAL##*[![:space:]]}"}"  # trim spaces
    ERR=$(check "$N" "$VAL")
    if [ -z "$VAL" ]; then echo "  empty, try again"; elif [ -n "$ERR" ]; then echo "  $N $ERR. Try again."; else echo "  ok (${#VAL} characters)"; break; fi
  done
  printf -v "V_$N" '%s' "$VAL"; export "V_$N"
done
unset VAL

# JSON is valid YAML; python escapes quotes/backslashes safely. Values travel via environment, not argv.
NAMES_CSV=$(IFS=,; echo "${NAMES[*]}") python3 - "$TMP" <<'PY'
import json, os, sys
names = os.environ["NAMES_CSV"].split(",")
with open(sys.argv[1], "w") as f:
    json.dump({"--update-env-vars": {n: os.environ["V_" + n] for n in names}}, f)
PY
for N in "${NAMES[@]}"; do unset "V_$N"; done

echo; echo "Applying merge-only update…"
"$G" run services update $SERVICE --project $PROJECT --region $REGION --flags-file="$TMP" --quiet 2>&1 | grep -E "Service \[|ERROR|failed" || true
rm -f "$TMP"

NEW=$("$G" run services describe $SERVICE --project $PROJECT --region $REGION --format='value(status.latestCreatedRevisionName)')
READY=$("$G" run services describe $SERVICE --project $PROJECT --region $REGION --format='value(status.latestReadyRevisionName)')
echo "Newest revision: $NEW   Serving (ready): $READY"
[ "$NEW" = "$READY" ] || echo "WARNING: the new revision did not become ready; traffic stays on $READY. Tell Claude."
echo "Variables on it: $("$G" run revisions describe "$NEW" --project $PROJECT --region $REGION --format='value(spec.containers[0].env[].name)' | tr ';' ' ')"
echo "Done. Tell Claude: \"secrets set\"."
