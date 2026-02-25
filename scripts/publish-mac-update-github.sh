#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "Missing GH_TOKEN. Create a GitHub personal access token with repo permissions and export GH_TOKEN." >&2
  exit 1
fi

OWNER="${GH_OWNER:-}"
REPO="${GH_REPO:-}"

if [[ -z "$OWNER" || -z "$REPO" ]]; then
  REMOTE_URL="$(git -C "$ROOT_DIR" config --get remote.origin.url || true)"

  if [[ "$REMOTE_URL" =~ ^git@github\.com:([^/]+)/([^/]+)(\.git)?$ ]]; then
    OWNER="${BASH_REMATCH[1]}"
    REPO="${BASH_REMATCH[2]}"
  elif [[ "$REMOTE_URL" =~ ^https://github\.com/([^/]+)/([^/]+)(\.git)?$ ]]; then
    OWNER="${BASH_REMATCH[1]}"
    REPO="${BASH_REMATCH[2]}"
  fi

  REPO="${REPO%.git}"
fi

if [[ -z "$OWNER" || -z "$REPO" ]]; then
  echo "Could not determine GitHub owner/repo." >&2
  echo "Set GH_OWNER and GH_REPO, or set a GitHub origin remote." >&2
  exit 1
fi

cd "$ROOT_DIR"
npm run icon:mac

echo "Publishing updates to GitHub Releases: ${OWNER}/${REPO}"
GH_OWNER="$OWNER" GH_REPO="$REPO" electron-builder --mac dmg zip --publish always
