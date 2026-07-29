#!/usr/bin/env bash
# Stands up the Modal side of the Brace pipeline in one go.
#
#   cd pipeline && ./setup.sh
#
# Discover does not need any of this — it runs on the website and only wants
# YOUTUBE_API_KEY in the Vercel project. This is for the three stages that need
# yt-dlp, ffmpeg and a GPU: triage, clip and prelabel.
#
# Nothing you type is echoed or written to a file. The values go straight into
# a Modal secret, which is where they live from then on.

set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ask() { # ask VAR "prompt" [optional]
  local var=$1 prompt=$2 optional=${3:-}
  local value=''
  while [ -z "$value" ]; do
    printf '  %s: ' "$prompt"
    read -rs value; echo
    if [ -z "$value" ] && [ -n "$optional" ]; then
      printf '     (skipped)\n'; break
    fi
    [ -z "$value" ] && printf '     needed — try again\n'
  done
  printf -v "$var" '%s' "$value"
}

say "1 · Modal"
# Into a virtual environment, always. Homebrew's Python refuses system-wide
# installs (PEP 668), and even where it does not, putting build tooling into
# the system Python is how a Mac's Python ends up broken. Everything lives in
# pipeline/.venv and can be deleted with the folder.
VENV="$PWD/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "  making a virtual environment in pipeline/.venv…"
  python3 -m venv "$VENV"
fi
PY="$VENV/bin/python"
MODAL="$VENV/bin/modal"

echo "  installing the Modal client…"
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet --upgrade modal fastapi

if ! "$MODAL" token show >/dev/null 2>&1; then
  echo "  opening a browser to sign you in…"
  "$PY" -m modal setup
fi
WORKSPACE=$("$MODAL" profile current 2>/dev/null || true)
echo "  signed in${WORKSPACE:+ as $WORKSPACE}"

say "2 · The keys it needs (nothing is echoed)"
echo "  Supabase service_role key"
echo "    https://supabase.com/dashboard/project/tvcbizxwadibtclamnyy/settings/api-keys"
ask SUPABASE_SERVICE_KEY "service_role key"
echo
echo "  YouTube Data API v3 key — the same one you put in Vercel"
ask YOUTUBE_API_KEY "YouTube API key"
echo
echo "  Anthropic API key, for scoring footage — https://console.anthropic.com"
echo "  Leave blank to skip: everything except the triage scoring still deploys"
echo "  and works, and re-running this script later slots the key in."
ask ANTHROPIC_API_KEY "Anthropic API key" optional
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
echo
echo "  Roboflow — https://app.roboflow.com. Leave blank to skip; everything up to"
echo "  pre-labelling still works, and you can re-run this later."
ask ROBOFLOW_API_KEY "Roboflow private API key" optional
if [ -n "${ROBOFLOW_API_KEY:-}" ]; then
  printf '  Roboflow project slug (from the URL, e.g. brace-clays): '
  read -r ROBOFLOW_PROJECT
else
  ROBOFLOW_API_KEY=""; ROBOFLOW_PROJECT=""
fi

echo
echo "  If you have run this before and already put a PIPELINE_TOKEN in Vercel,"
echo "  paste it so the two keep matching. Blank invents a fresh one."
ask PIPELINE_TOKEN "existing pipeline token (blank for new)" optional
PIPELINE_TOKEN=${PIPELINE_TOKEN:-$("$PY" -c 'import secrets; print(secrets.token_hex(32))')}

say "3 · Storing them in Modal"
"$MODAL" secret create brace-pipeline \
  SUPABASE_URL="https://tvcbizxwadibtclamnyy.supabase.co" \
  SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  YOUTUBE_API_KEY="$YOUTUBE_API_KEY" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  ROBOFLOW_API_KEY="$ROBOFLOW_API_KEY" \
  ROBOFLOW_PROJECT="$ROBOFLOW_PROJECT" \
  PIPELINE_TOKEN="$PIPELINE_TOKEN" \
  --force
echo "  secret 'brace-pipeline' written"

say "4 · Deploying"
"$MODAL" deploy modal_app.py

say "5 · Finish in Vercel"
cat <<EOF
  Modal printed the endpoint URLs just above. Take the part before "-triage",
  for example  https://yourname--brace-pipeline

  Then at  https://vercel.com  →  your brace project  →  Settings  →
  Environment Variables, set:

    SUPABASE_URL       https://tvcbizxwadibtclamnyy.supabase.co
    SUPABASE_ANON_KEY  (the anon key — it is already public in the site)
    YOUTUBE_API_KEY    the same YouTube key you just gave Modal
    PIPELINE_TOKEN     $PIPELINE_TOKEN
    MODAL_BASE_URL     https://<workspace>--brace-pipeline

  Then Deployments → the top one → ⋯ → Redeploy. Environment variables only
  reach a new deployment, so this step is not optional.

  That token is printed once, here. It never needs to be anywhere else.
EOF
