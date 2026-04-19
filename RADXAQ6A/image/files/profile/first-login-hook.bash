
# TrailCurrent Headwaters — first-login wizard
# Runs once on the first interactive shell when $HOME/.env is missing,
# then never again (the wizard creates .env + a sentinel file).
if [ ! -f "$HOME/.env" ] && [ ! -f "$HOME/.headwaters-setup-complete" ] && [ -t 0 ]; then
    /usr/local/bin/headwaters-first-login.sh
fi
