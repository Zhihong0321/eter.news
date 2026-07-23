FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY public ./public
COPY src ./src

EXPOSE 5177
ENV PORT=5177
ENV NODE_ENV=production

CMD ["node", "src/server.js"]
