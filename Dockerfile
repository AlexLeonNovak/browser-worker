FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal tools + Xvfb for optional headful (headless: false) mode.
# Chrome's own .deb pulls in all of its runtime libraries automatically.
RUN apt-get update && apt-get install -y \
    wget ca-certificates \
    xvfb dbus-x11 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Official Google Chrome stable — installs to /opt/google/chrome/chrome,
# which is exactly where Patchright/Playwright's channel: 'chrome' looks.
RUN wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y ./google-chrome-stable_current_amd64.deb \
    && rm google-chrome-stable_current_amd64.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY src/ ./src/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001

# tini as PID 1 reaps orphans. Chrome's helpers (chrome, chrome_crashpad) get
# re-parented to PID 1 when a browser closes, and node never waits on them:
# 68 zombies after 17h, and after 32 days the pids limit was hit and nothing
# could fork. Baked into the image so it holds however the container is run.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
