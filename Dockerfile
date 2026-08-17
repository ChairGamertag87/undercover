FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY data ./data
COPY public ./public

EXPOSE 8080
USER node
CMD ["node", "server.js"]
