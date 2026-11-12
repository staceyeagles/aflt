# bash completion for agentfleet / af
_af() {
  local cur prev cmds
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  cmds="new add import ls list sync run log resume pick rename done rm remove note export import-file which-backend herdr-templates help"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "${cur}") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    resume|pick)
      COMPREPLY=( $(compgen -W "--all --via --tag --dry-run --tmux-session --here --open --no-open --prompt --interactive -i tmux iterm2 wezterm herdr plain" -- "${cur}") )
      ;;
    new|add)
      COMPREPLY=( $(compgen -W "--cwd --prompt --model --tag --chat --dry-run" -- "${cur}") )
      ;;
    run)
      COMPREPLY=( $(compgen -W "--prompt --cwd --model --engine --mode --force --output-format --timeout --dry-run --no-trust --no-silent cursor copilot ask plan text json" -- "${cur}") )
      ;;
    log)
      COMPREPLY=( $(compgen -W "--path" -- "${cur}") )
      ;;
    herdr-templates)
      COMPREPLY=( $(compgen -W "--force" -- "${cur}") )
      ;;
    ls|list)
      COMPREPLY=( $(compgen -W "--status --tag --all --json" -- "${cur}") )
      ;;
    sync)
      COMPREPLY=( $(compgen -W "--dry-run --json" -- "${cur}") )
      ;;
  esac
}
complete -F _af af
complete -F _af agentfleet
