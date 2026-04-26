#!/bin/bash
# Daily health check for digitaldialogue.com.au.
# Probes the 4-platform parser by hitting /api/info with one random seed URL per
# platform (Douyin, TikTok, X, Instagram), HEAD-checks the returned CDN URL,
# classifies each as PASS / SOFT-FAIL (documented platform rate limit) /
# HARD-FAIL (parser bug), and appends a one-line summary to the log.
# Stdout: per-platform status lines + worst-of summary.
#
# Local runtime (Peter's setup): scheduled by ~/.claude/scheduled-tasks/digitaldialogue-health-check/SKILL.md (09:09 daily).
# Repo copy: scripts/health-check.sh in shineyear/douyin-tiktok-downloader.

set -u

LOG="$HOME/Library/Logs/digitaldialogue-check.log"
mkdir -p "$(dirname "$LOG")"

DOUYIN=(
  'https://v.douyin.com/9zCRrjMtxL8'
  'https://v.douyin.com/OuSt8KHbgHU'
)
TIKTOK=(
  'https://www.tiktok.com/@9news/video/7283777168503573768'
  'https://www.tiktok.com/@blackcardlondon/video/7512419868210171158'
  'https://www.tiktok.com/@tiktok/video/7106594312292453675'
  'https://www.tiktok.com/t/ZTkQ41K3L/'
)
TWITTER=(
  'https://x.com/WhiteHouse/status/2031895801064985021'
  'https://x.com/OpenAI/status/2047376561205325845'
)
INSTAGRAM=(
  'https://www.instagram.com/reel/DUuJKDGjvw_/'
  'https://www.instagram.com/reel/DVgi2jQjrcA/'
)

urlencode() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
pick_random() { local arr_name="$1[@]"; local arr=("${!arr_name}"); echo "${arr[RANDOM % ${#arr[@]}]}"; }

# Probes one share URL. Echoes "STATUS|tested_url|message" where STATUS in PASS/SOFT/HARD.
probe_one() {
  local share_url="$1"
  local enc; enc=$(urlencode "$share_url")
  local body; body=$(curl -sS -m 20 "https://digitaldialogue.com.au/api/info?url=$enc" 2>&1)
  local code=$?
  if [[ $code -ne 0 ]]; then
    echo "HARD|$share_url|curl failed: $body"
    return
  fi
  local err; err=$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("__BADJSON__"); sys.exit()
if d.get("direct", {}).get("url"):
    print("")
else:
    print(d.get("error", "unknown error"))
' 2>/dev/null)
  if [[ "$err" == "__BADJSON__" ]]; then
    echo "HARD|$share_url|non-JSON response (first 120 chars): $(printf '%s' "$body" | head -c 120)"
    return
  fi
  if [[ -n "$err" ]]; then
    if printf '%s' "$err" | grep -qE '风控|10-30 分钟|rate-limit|require_login|429'; then
      echo "SOFT|$share_url|$err"
    else
      echo "HARD|$share_url|$err"
    fi
    return
  fi
  local cdn; cdn=$(printf '%s' "$body" | python3 -c 'import sys,json;print(json.load(sys.stdin)["direct"]["url"])')
  local head_code; head_code=$(curl -sSI -m 15 -o /dev/null -w '%{http_code}' "$cdn" 2>/dev/null)
  if [[ "$head_code" =~ ^(200|206|301|302)$ ]]; then
    echo "PASS|$share_url|"
    return
  fi
  if [[ "$head_code" == "403" || "$head_code" == "405" || "$head_code" == "504" ]]; then
    head_code=$(curl -sS -m 15 --range 0-0 -o /dev/null -w '%{http_code}' "$cdn" 2>/dev/null)
    if [[ "$head_code" =~ ^(200|206)$ ]]; then
      echo "PASS|$share_url|"
      return
    fi
  fi
  echo "HARD|$share_url|CDN check returned HTTP $head_code"
}

# Probes a platform: tries one random URL; on HARD, retries with a different random URL.
probe_platform() {
  local arr_name="$1"
  local first; first=$(pick_random "$arr_name")
  local r1; r1=$(probe_one "$first")
  local s1=${r1%%|*}
  if [[ "$s1" != "HARD" ]]; then
    echo "$r1"
    return
  fi
  local arr_ref="$arr_name[@]"; local arr=("${!arr_ref}")
  if [[ ${#arr[@]} -gt 1 ]]; then
    local second="$first"
    while [[ "$second" == "$first" ]]; do
      second=$(pick_random "$arr_name")
    done
    local r2; r2=$(probe_one "$second")
    local s2=${r2%%|*}
    if [[ "$s2" == "PASS" || "$s2" == "SOFT" ]]; then
      echo "$r2"
      return
    fi
    echo "HARD|$first|${r1#HARD|*|}  ||  retry $second: ${r2#HARD|*|}"
    return
  fi
  echo "$r1"
}

PLATFORMS=(Douyin TikTok X Instagram)
ARRAYS=(DOUYIN TIKTOK TWITTER INSTAGRAM)
RESULTS=()
WORST=PASS
for i in 0 1 2 3; do
  r=$(probe_platform "${ARRAYS[$i]}")
  RESULTS+=("${PLATFORMS[$i]}|$r")
  s=${r%%|*}
  case "$s" in
    HARD) WORST=HARD ;;
    SOFT) [[ "$WORST" == "PASS" ]] && WORST=SOFT ;;
  esac
done

TS=$(date -u +'%Y-%m-%d %H:%M:%S UTC')
TS_LOCAL=$(date +'%Y-%m-%d %H:%M:%S %Z')

# Build summary lines for log + body.
SUMMARY=""
for r in "${RESULTS[@]}"; do
  IFS='|' read -r platform status url msg <<< "$r"
  case "$status" in
    PASS) emoji='✅' ;;
    SOFT) emoji='⚠️' ;;
    HARD) emoji='❌' ;;
  esac
  if [[ -n "$msg" ]]; then
    SUMMARY+="$emoji $platform: $status — $msg ($url)"$'\n'
  else
    SUMMARY+="$emoji $platform: $status ($url)"$'\n'
  fi
done

# Log full details.
{
  echo "=== $TS_LOCAL ==="
  echo "Worst status: $WORST"
  echo "$SUMMARY"
} >> "$LOG"

# Build notification.
case "$WORST" in
  PASS)
    NOTIF_TITLE='✅ digitaldialogue health check'
    NOTIF_SUBTITLE='All 4 platforms OK'
    NOTIF_BODY=$(printf '%s' "$SUMMARY" | sed 's/ (https.*$//')
    NOTIF_SOUND='Glass'
    ;;
  SOFT)
    NOTIF_TITLE='⚠️ digitaldialogue health check'
    soft_count=$(printf '%s' "$SUMMARY" | grep -c '⚠️') || soft_count=0
    NOTIF_SUBTITLE="$soft_count soft-fail (likely IG rate limit)"
    NOTIF_BODY=$(printf '%s' "$SUMMARY" | sed 's/ (https.*$//')
    NOTIF_SOUND='Glass'
    ;;
  HARD)
    NOTIF_TITLE='🚨 digitaldialogue health check FAIL'
    broken=$(printf '%s' "$SUMMARY" | grep '❌' | awk -F: '{print $1}' | sed 's/❌ //' | tr '\n' ',' | sed 's/,$//')
    NOTIF_SUBTITLE="Broken: $broken"
    NOTIF_BODY=$(printf '%s' "$SUMMARY" | sed 's/ (https.*$//')
    NOTIF_SOUND='Sosumi'
    ;;
esac

# osascript escape: backslashes and double quotes.
escape_for_applescript() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

T=$(escape_for_applescript "$NOTIF_TITLE")
ST=$(escape_for_applescript "$NOTIF_SUBTITLE")
BD=$(escape_for_applescript "$NOTIF_BODY")

osascript -e "display notification \"$BD\" with title \"$T\" subtitle \"$ST\" sound name \"$NOTIF_SOUND\""

echo "$SUMMARY"
echo "Worst: $WORST"
