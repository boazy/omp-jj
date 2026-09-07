#!/usr/bin/env bash
# dots-integration/install.sh - Install wt/wtm unified helper into ~/dots/bin
#
# Idempotently sets executable permissions, backs up existing non-symlink binaries
# to *.bak (refusing if backup already exists), and symlinks wt and wtm into ~/dots/bin.
# Supports --dry-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

HELPER_WT="${REPO_DIR}/helper/wt.py"
HELPER_WTM="${REPO_DIR}/helper/wtm.py"

DOTS_DIR="${DOTS_DIR:-${HOME}/dots}"
DOTS_BIN="${DOTS_DIR}/bin"

TARGET_WT="${DOTS_BIN}/wt"
TARGET_WTM="${DOTS_BIN}/wtm"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n)
      DRY_RUN=true
      ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --dry-run, -n   Print planned actions without modifying files"
      echo "  -h, --help      Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

log_action() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] $*"
  else
    echo "==> $*"
  fi
}

# 1. Verify sources exist
for src in "$HELPER_WT" "$HELPER_WTM"; do
  if [[ ! -f "$src" ]]; then
    echo "Error: helper source not found: $src" >&2
    exit 1
  fi
done

# 2. Ensure helpers are executable
for src in "$HELPER_WT" "$HELPER_WTM"; do
  if [[ ! -x "$src" ]]; then
    log_action "chmod +x $src"
    if [[ "$DRY_RUN" == false ]]; then
      chmod +x "$src"
    fi
  else
    log_action "$src is already executable (+x)"
  fi
done

# 3. Ensure DOTS_BIN directory exists
if [[ ! -d "$DOTS_BIN" ]]; then
  log_action "mkdir -p $DOTS_BIN"
  if [[ "$DRY_RUN" == false ]]; then
    mkdir -p "$DOTS_BIN"
  fi
fi

# 4. Helper function to link target
install_symlink() {
  local src="$1"
  local target="$2"
  local bak="${target}.bak"

  if [[ -L "$target" ]]; then
    local current_dest
    current_dest="$(readlink "$target")"
    if [[ "$current_dest" == "$src" ]]; then
      log_action "$target already symlinked to $src"
      return 0
    fi
    log_action "Updating symlink: $target -> $src (was -> $current_dest)"
    if [[ "$DRY_RUN" == false ]]; then
      ln -sf "$src" "$target"
    fi
    return 0
  fi

  if [[ -e "$target" ]]; then
    # Regular file or directory (non-symlink)
    if [[ -e "$bak" ]]; then
      echo "Error: backup file already exists: $bak" >&2
      echo "       Refusing to overwrite existing backup. Inspect and remove/rename it first." >&2
      exit 1
    fi
    log_action "Backing up non-symlink $target -> $bak"
    if [[ "$DRY_RUN" == false ]]; then
      mv "$target" "$bak"
    fi
  fi

  log_action "Creating symlink: $target -> $src"
  if [[ "$DRY_RUN" == false ]]; then
    ln -s "$src" "$target"
  fi
}

install_symlink "$HELPER_WT" "$TARGET_WT"
install_symlink "$HELPER_WTM" "$TARGET_WTM"

echo ""
echo "Installation complete $([[ "$DRY_RUN" == true ]] && echo "(dry-run)")!"
echo ""
echo "Verification steps:"
echo "  1. Inspect symlinks:"
echo "     ls -l \"$TARGET_WT\" \"$TARGET_WTM\""
echo "  2. Test CLI execution:"
echo "     \"$TARGET_WT\" --help"
echo "     \"$TARGET_WTM\" --help"
echo "  3. Apply the shell wrapper patch to ~/dots/zsh/custom/git.zsh:"
echo "     patch -p1 -d \"$DOTS_DIR\" < \"${REPO_DIR}/dots-integration/git.zsh.patch\""
echo "  4. Reload shell functions:"
echo "     source \"${DOTS_DIR}/zsh/custom/git.zsh\""
echo "  5. Verify in a JJ or Git repository:"
echo "     wt list"
echo "     wt main"
