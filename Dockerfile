FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY public ./public
COPY src ./src
COPY templates ./templates

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "src/server.js"]
