# Build for the web AppView.
#
# Explicit rather than auto-detected. This repository holds a Node workspace and
# a Go module side by side, and a build-pack guessing from the root finds go.mod
# first and builds the wrong service — which is exactly what happened on the
# first deploy attempt.
#
# There is no compile step: @f8130/core is consumed as raw TypeScript and run
# through tsx, so the image ships sources and a production dependency tree.

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Manifests first, so a dependency layer is only rebuilt when dependencies
# actually change rather than on every source edit.
COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY web/package.json web/package.json

# npm ci needs the whole workspace tree present to resolve the lockfile.
RUN npm ci --omit=dev --ignore-scripts

COPY core core
COPY web web

EXPOSE 3000
CMD ["npm", "start", "--workspace", "web"]
