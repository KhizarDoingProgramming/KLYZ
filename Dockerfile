FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first so source edits don't invalidate the layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# A production server by default: `next dev` would disable every
# production-only behaviour in this app (secure cookies, HSTS, the
# strict CSP, the refusal of the in-process queue and the mock AI
# provider). Development runs go through `docker compose --profile
# app`, which overrides this command with `npm run dev`.
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
