FROM node:22-bookworm-slim
# openssl: firma de los pases de Apple
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY assets ./assets
ENV NODE_ENV=production
ENV DB_FILE=/data/loyalty.db
EXPOSE 3000
CMD ["node", "src/server.js"]
