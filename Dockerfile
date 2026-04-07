FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Dependencies for Chrome
RUN apt-get update && apt-get install -y \
    wget curl gnupg unzip \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatspi2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libgcc-s1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libstdc++6 libx11-6 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libxss1 libxtst6 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Chrome for Testing (чистий URL!)
RUN mkdir -p /opt/chrome \
    && wget -q https://storage.googleapis.com/chrome-for-testing-public/147.0.7727.50/linux64/chrome-linux64.zip \
    && unzip chrome-linux64.zip -d /opt/chrome/ \
    && rm chrome-linux64.zip \
    && ln -sf /opt/chrome/chrome-linux64/chrome /usr/local/bin/google-chrome \
    && chmod +x /usr/local/bin/google-chrome

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npx playwright install chromium

COPY package.json .
RUN npm install

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/server.js"]