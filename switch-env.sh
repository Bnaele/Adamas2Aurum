#!/usr/bin/env bash

set -e

TARGET_DIR="${2:-.}"

LOCAL_HTTP="${BACKEND_LOCAL_URL:-http://localhost:3000}"
RENDER_HTTP="${BACKEND_RENDER_URL}"
if [[ -z "$BACKEND_RENDER_URL" ]]; then
	if [[ -z "$BACKEND_URL" ]]; then
		echo "Missing env \$BACKEND_RENDER_URL"
		exit 1
	else
		RENDER_HTTP="${BACKEND_URL}"
	fi
fi

to_ws() {
	local url="$1"
	case "$url" in
	https://*) echo "wss://${url#https://}" ;;
	http://*) echo "ws://${url#http://}" ;;
	*) echo "$url" ;;
	esac
}

LOCAL_WS="$(to_ws "$LOCAL_HTTP")"
RENDER_WS="$(to_ws "$RENDER_HTTP")"

case "$1" in
local)
	FROM_HTTP="$RENDER_HTTP"
	TO_HTTP="$LOCAL_HTTP"
	FROM_WS="$RENDER_WS"
	TO_WS="$LOCAL_WS"
	;;

render)
	FROM_HTTP="$LOCAL_HTTP"
	TO_HTTP="$RENDER_HTTP"
	FROM_WS="$LOCAL_WS"
	TO_WS="$RENDER_WS"
	;;

*)
	echo "Usage: $0 {local|render} [directory]"
	exit 1
	;;
esac

echo "\"$FROM_HTTP\" -> \"$TO_HTTP\""
echo "\"$FROM_WS\" -> \"$TO_WS\""

find "$TARGET_DIR" -type f -regextype posix-extended -regex '.*\.(js|html)' -print0 |
	while IFS= read -r -d '' FILE; do
		echo "processing \"$FILE\""
		sed -i.bak \
			-e "s|$FROM_HTTP|$TO_HTTP|g" \
			-e "s|$FROM_WS|$TO_WS|g" \
			"$FILE"

		rm -f "${FILE}.bak"
	done

echo "Switched to $1"
