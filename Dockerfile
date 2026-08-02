FROM node:22-alpine

RUN apk add --no-cache curl git

WORKDIR /app

# package-lock.json is deliberately NOT copied here - see events-service's Dockerfile for
# why (reifying it with --omit=dev triggers a reproducible npm bug in a clean container).
# Resolving fresh from package.json avoids it; the git dependencies are already pinned to
# branches for reproducibility.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4012

CMD ["npm", "start"]
