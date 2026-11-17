#!/usr/bin/env bash

# This should be run by $BOTNAME user just after executing setup_root.sh as root
SCRIPTPATH="$(
    cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 || exit
    pwd -P
)"

pushd "$SCRIPTPATH" >/dev/null || exit
if [[ ! $(git remote -v) ]]; then
    echo ERROR!! "$SCRIPTPATH" is not a cloned repository
    popd >/dev/null || exit
    return 1
fi

echo "Running npm update..."
cd proxy

# Run npm update with JSON format and capture output
# '|| true' ensures the script keeps running if npm throws an exit code
UPDATE_JSON=$(docker run --rm --user "$(id -u):$(id -g)" -v "$(pwd)":/app -w /app node:26-alpine npm update --json --no-update-notifier || true)

# Extract names of updated packages using jq
UPDATED_PACKAGES=$(echo "$UPDATE_JSON" | jq -r '.add[].name, .change[].to.name' 2>/dev/null)

if [ -z "$UPDATED_PACKAGES" ]; then
    echo "No packages were updated."
    exit 0
fi

echo "The following packages were updated:"
echo "$UPDATED_PACKAGES"
