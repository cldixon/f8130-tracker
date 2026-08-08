FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY web/package.json web/package.json
COPY seed/package.json seed/package.json
COPY watchdog/package.json watchdog/package.json
RUN npm ci --omit=dev --ignore-scripts

COPY watchdog watchdog

CMD ["npm", "start", "--workspace", "watchdog"]
