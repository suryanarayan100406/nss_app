FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN npm install
COPY . .
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
RUN npm run build:api
CMD ["npm", "run", "start:api"]
