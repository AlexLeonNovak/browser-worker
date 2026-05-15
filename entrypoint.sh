#!/bin/sh
set -e

Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR -nolisten tcp &
export DISPLAY=:99

exec node src/server.js
