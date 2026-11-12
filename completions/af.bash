# bash completion for agentfleet / af
_af_session_titles() {
  local home reg
  home="${AGENTFLEET_HOME:-$HOME/.agentfleet}"
  reg="${AGENTFLEET_REGISTRY:-$home/sessions.json}"
  if [[ ! -f "$reg" ]]; then
    return 0
  fi
  # Prefer node (af already requires it); fall back to empty
  node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const s of d.sessions || []) {
        if (s && s.title) process.stdout.write(s.title + "\n");
      }
    } catch (_) {}
  ' "$reg" 2>/dev/null
}

_af() {
  local cur prev cmds titles
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  cmds="new add import ls list sync run log spawn children result wait tail send stop resume pick adopt cursor copilot engine rename done rm remove note export import-file which-backend herdr-templates herdr-app help"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "${cur}") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    resume|pick)
      COMPREPLY=( $(compgen -W "--all --via --tag --dry-run --tmux-session --here --open --no-open --no-herdr-app --prompt --force --interactive -i tmux iterm2 wezterm herdr plain" -- "${cur}") )
      ;;
    adopt)
      COMPREPLY=( $(compgen -W "--all --dry-run --json" -- "${cur}") )
      ;;
    new|add)
      COMPREPLY=( $(compgen -W "--cwd --prompt --model --tag --chat --engine --force --dry-run --no-trust cursor copilot" -- "${cur}") )
      ;;
    run)
      COMPREPLY=( $(compgen -W "--prompt --cwd --model --engine --mode --force --output-format --timeout --dry-run --no-trust --no-silent cursor copilot ask plan text json" -- "${cur}") )
      ;;
    spawn)
      if [[ "$prev" == "--parent" ]]; then
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "--parent --prompt --engine --cwd --title --task --model --timeout --force --interactive --dry-run --json --no-trust cursor copilot" -- "${cur}") )
      fi
      ;;
    children)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--json --all" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--json --all ${titles}" -- "${cur}") )
      fi
      ;;
    result)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--path" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--path ${titles}" -- "${cur}") )
      fi
      ;;
    wait)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--any --timeout --interval --json" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--any --timeout --interval --json ${titles}" -- "${cur}") )
      fi
      ;;
    tail)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "-n -f --follow" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "-n -f --follow ${titles}" -- "${cur}") )
      fi
      ;;
    send)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--timeout --force --no-trust" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--timeout --force --no-trust ${titles}" -- "${cur}") )
      fi
      ;;
    stop)
      if [[ "$cur" == -* || "$prev" == "--all-children" ]]; then
        if [[ "$prev" == "--all-children" ]]; then
          titles="$(_af_session_titles)"
          COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
        else
          COMPREPLY=( $(compgen -W "--all-children --json" -- "${cur}") )
        fi
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--all-children --json ${titles}" -- "${cur}") )
      fi
      ;;
    engine)
      COMPREPLY=( $(compgen -W "cursor copilot" -- "${cur}") )
      ;;
    log)
      COMPREPLY=( $(compgen -W "--path" -- "${cur}") )
      ;;
    herdr-templates)
      COMPREPLY=( $(compgen -W "--force" -- "${cur}") )
      ;;
    herdr-app)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "install status" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "--copy --force --dry-run" -- "${cur}") )
      fi
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
