#!/usr/bin/env python3
"""
Ported from setup.sh (using Claude) — works on macOS/Linux/Windows without needing
separate bash/PowerShell scripts.

Usage:
    python3 setup.py            # start:backend / start:frontend
    python3 setup.py --dev      # dev:backend   / dev:frontend
"""

import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

ENV_EXAMPLE = Path("app/src/backend/.env.example")
ENV_FILE = Path("app/src/backend/.env")

# ---------- output helpers ----------

def _enable_ansi_on_windows():
    # Windows 10+ cmd.exe needs this poked once to honor ANSI escape codes.
    if os.name == "nt":
        os.system("")

def info(msg):
    print(f"\033[1;35m[info]\033[0m {msg}")

def warn(msg):
    print(f"\033[1;33m[warn]\033[0m {msg}")

def err(msg):
    print(f"\033[1;31m[error]\033[0m {msg}", file=sys.stderr)

def ask_yes_no(prompt):
    while True:
        reply = input(f"{prompt} [y/N]: ").strip()
        if reply in ("y", "Y"):
            return True
        if reply in ("n", "N", ""):
            return False
        print("Please answer y or n.")

# ---------- process helpers ----------

def find_npm():
    npm = shutil.which("npm")
    if npm is None:
        err("npm is not installed or not on PATH.")
        sys.exit(1)
    return npm

def run_checked(npm, *npm_args):
    """Run `npm <npm_args>` and exit if it fails (mirrors `set -e`)."""
    result = subprocess.run([npm, *npm_args])
    if result.returncode != 0:
        err(f"'npm {' '.join(npm_args)}' failed with exit code {result.returncode}")
        sys.exit(result.returncode)

def start_background(npm, *npm_args):
    """Start `npm <npm_args>` in the background, in its own process group
    so we can reliably kill it (and any child processes, e.g. node) later."""
    if os.name == "nt":
        return subprocess.Popen(
            [npm, *npm_args],
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    return subprocess.Popen([npm, *npm_args], preexec_fn=os.setsid)

def kill_process_tree(proc):
    if proc is None or proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass

# ---------- main ----------

def main():
    _enable_ansi_on_windows()

    mode = "dev" if "--dev" in sys.argv[1:] else "start"
    for arg in sys.argv[1:]:
        if arg not in ("--dev",):
            warn(f"Unknown argument: {arg}")

    npm = find_npm()

    info("Installing dependencies...")
    run_checked(npm, "run", "install-deps")

    if ask_yes_no("Would you like to set up a local MySQL DB using Docker?"):
        info("Checking for Docker...")
        if shutil.which("docker") is None:
            err("Docker is not installed or not on PATH.")
            sys.exit(1)

        info("Checking for Docker Compose...")
        compose_check = subprocess.run(
            ["docker", "compose", "version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if compose_check.returncode != 0:
            err("Docker Compose is not available.")
            sys.exit(1)

        if ENV_FILE.is_file():
            info(f"{ENV_FILE} already exists.")
        elif ENV_EXAMPLE.is_file():
            info(f"Copying {ENV_EXAMPLE} to {ENV_FILE}...")
            shutil.copy(ENV_EXAMPLE, ENV_FILE)
        else:
            warn(f"{ENV_EXAMPLE} not found.")

        info("Starting the database")
        run_checked(npm, "run", "db:up")

        info("Resetting the database")
        run_checked(npm, "run", "db:reset")

        info("Seeding the database")
        run_checked(npm, "run", "db:seed")

        print(
            "\nDatabase is up.\n\n"
            "Usage:\n"
            "  Stop the database:   npm run db:down\n"
            "  Delete DB entirely:  docker compose down -v   (run from app/src/backend)\n"
        )
    else:
        info("Skipping local DB setup.")

    info("Starting backend and frontend.")

    backend_proc = start_background(npm, "run", f"{mode}:backend")
    frontend_proc = start_background(npm, "run", f"{mode}:frontend")

    def _on_signal(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _on_signal)

    try:
        backend_proc.wait()
        frontend_proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        kill_process_tree(backend_proc)
        kill_process_tree(frontend_proc)

if __name__ == "__main__":
    main()

""" Original setup.sh

#!/bin/bash

# `-e`: means the shell will exit when any cmd fails
# `-o pipefail`: will set the return value for the program to the exit status of the last cmd
set -eo pipefail

ENV_EXAMPLE="app/src/backend/.env.example"
ENV_FILE="app/src/backend/.env"
MODE="start"

for arg in "$@"; do
	case "$arg" in
	--dev) MODE="dev" ;;
	*) warn "Unknown argument: $arg" ;;
	esac
done

cleanup() {
    set +e
    trap - INT TERM EXIT
    echo "hi"
    kill 0
}

info() { printf '\033[1;35m[info]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; }

ask_yes_no() {
	local prompt="$1" reply
	while true; do
		read -r -p "$prompt [y/N]: " reply
		case "$reply" in
		[Yy]) return 0 ;;
		[Nn] | "") return 1 ;;
		*) echo "Please answer y or n." ;;
		esac
	done
}

info "Installing dependencies..."
npm run install-deps

if ask_yes_no "Would you like to set up a local MySQL DB using Docker?"; then
	info "Checking for Docker..."
	if ! command -v docker > /dev/null 2>&1; then
		err "Docker is not installed or not on PATH."
		exit 1
	fi
	info "Checking for Docker Compose..."
	if ! docker compose version > /dev/null 2>&1; then
		err "Docker Compose is not available."
		exit 1
	fi

	if [ -f "$ENV_FILE" ]; then
		info "$ENV_FILE already exists."
	elif [ -f "$ENV_EXAMPLE" ]; then
		info "Copying $ENV_EXAMPLE to $ENV_FILE..."
		cp "$ENV_EXAMPLE" "$ENV_FILE"
	else
		warn "$ENV_EXAMPLE not found."
	fi

	info "Starting the database"
	npm run db:up

	info "Resetting the database"
	npm run db:reset

	info "Seeding the database"
	npm run db:seed
	cat << 'EOF'

Database is up.

Usage:
  Stop the database:   npm run db:down
  Delete DB entirely:  sudo docker compose down -v   (run from app/src/backend)

EOF
else
	info "Skipping local DB setup."
fi

info "Starting backend and frontend."

trap cleanup INT TERM EXIT

# Start your background processes
npm run "${MODE}:backend" &
npm run "${MODE}:frontend" &

# Wait for them to finish
wait
"""
