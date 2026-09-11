FROM node:20-slim

# Prisma's query engine binary needs OpenSSL at runtime — node:20-slim
# doesn't include it by default, which would otherwise fail at startup
# with a "libssl.so" error rather than at build time.
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server deps first (better layer caching) and generate the
# Prisma client, which needs the schema present.
COPY server/package*.json server/
RUN npm install --prefix server

COPY server/prisma server/prisma
RUN npx prisma generate --schema=server/prisma/schema.prisma

COPY server server

# Build the client into client/dist, which server/src/index.js serves
# statically alongside the API.
COPY client/package*.json client/
RUN npm install --prefix client

COPY client client
RUN npm run build --prefix client

EXPOSE 4000
CMD ["npm", "--prefix", "server", "run", "start"]
