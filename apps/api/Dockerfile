FROM node:24-bookworm-slim
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN npm install
COPY . .
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
CMD ["npm", "run", "start:api"]
