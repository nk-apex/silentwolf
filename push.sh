#!/usr/bin/env bash
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "Error: GITHUB_TOKEN is not set"
  exit 1
fi

REMOTE="https://7silent-wolf:${GITHUB_TOKEN}@github.com/7silent-wolf/silentwolf-baileys.git"

echo "Pushing to github.com/7silent-wolf/silentwolf-baileys ..."
git push --force --set-upstream "$REMOTE" main
echo "Done."
