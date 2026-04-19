# TrailCurrent Headwaters — branded shell prompt and aliases
# Sourced by /etc/profile via /etc/profile.d/

if [ -n "${BASH_VERSION:-}" ] && [ -t 0 ]; then
    PS1='\[\033[38;5;70m\]trail\[\033[38;5;30m\]current\[\033[0m\]@\[\033[38;5;70m\]\h\[\033[0m\]:\w\$ '
fi

# Convenience aliases
alias tc-logs='docker compose logs -f'
alias tc-status='docker compose ps'
alias tc-restart='docker compose restart'
alias tc-can-logs='sudo journalctl -u cantomqtt -f'
alias tc-watcher-logs='sudo journalctl -u deployment-watcher -f'
