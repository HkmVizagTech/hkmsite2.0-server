
FROM node:18-alpine AS builder

# cache-bust: 2026-07-10
WORKDIR /usr/src/app

# sharp requires these native libraries on Alpine
RUN apk add --no-cache python3 make g++ vips-dev

COPY package*.json ./

RUN npm ci --only=production

COPY . .

FROM node:18-alpine
WORKDIR /usr/src/app

# sharp runtime libraries
RUN apk add --no-cache vips

COPY --from=builder /usr/src/app .

EXPOSE 3003

ENV NODE_ENV=production

CMD ["node", "index.js"]
