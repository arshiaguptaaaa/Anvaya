# Anvaya app server for Google Cloud Run (split setup: app.anvayacareers.in). Secrets come from Cloud Run settings, never the image.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY supabase ./supabase
COPY scripts ./scripts
USER node
CMD ["node", "src/server.js"]
