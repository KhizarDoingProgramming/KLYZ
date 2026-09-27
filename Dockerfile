FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first so source edits don't invalidate the layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000
CMD ["npm", "run", "dev"]
