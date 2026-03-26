#!/usr/bin/env bash
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "Error: GITHUB_TOKEN is not set"
  exit 1
fi

REMOTE="https://nk-apex:${GITHUB_TOKEN}@github.com/nk-apex/silentwolf.git"

echo "Pushing to github.com/nk-apex/silentwolf ..."
git push --set-upstream "$REMOTE" main
echo "Done."
