#!/usr/bin/env bash

# This should be run by $BOTNAME user
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

docker compose up -d --build

popd >/dev/null || exit
