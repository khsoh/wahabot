#!/usr/bin/env bash

# This should be run by $BOTNAME user just after executing setup_root.sh as root
SCRIPTPATH="$(
    cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 || exit
    pwd -P
)"

# Setup HOSTNAME properly
echo 'export HOSTNAME=$(hostname)' >>~/.bashrc

pushd "$SCRIPTPATH" >/dev/null || exit
if [[ ! $(git remote -v) ]]; then
    echo ERROR!! "$SCRIPTPATH" is not a cloned repository
    popd >/dev/null || exit
    return 1
fi
mkdir shared-tmp
chmod 755 shared-tmp

# Install nodejs packages
cd proxy
npm install
popd >/dev/null || exit

CFGENV="$SCRIPTPATH/.env"
BOTNAME=$(grep -v '^#' "${CFGENV}" | grep '^NAME=' | cut -d '=' -f2- | sed 's/^"//;s/"$//')

cat <<__end
Install the ssh public key of source PC/Mac to ~/.ssh/authorized_keys
scp <SSH public key of source PC/Mac> $BOTNAME@$HOSTNAME:~/srcpubkey
ssh $BOTNAME@$HOSTNAME "cat ~/srcpubkey >> ~/.ssh/authorized_keys"
__end

# Set environment variables (adjust folder name as needed)
echo 'export JAVA_HOME="/usr/lib/jvm/java-25-openjdk-amd64"' >>~/.bashrc
echo 'export PATH="$JAVA_HOME/bin:$PATH"' >>~/.bashrc
source ~/.bashrc

# Link to bot's signal account
echo "Prepare for Signal App on phone to scan QR code"
read -n 1 -s -r -p "Press any key to continue... "
echo ""

/usr/local/bin/signal-cli \
    --config /home/$BOTNAME/.local/share/signal-cli \
    link -n "$HOSTNAME" | xargs -L 1 qrencode -t utf8
