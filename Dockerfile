FROM node:22-alpine

WORKDIR /app

COPY package.json .

RUN npm install

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/server.js"]
