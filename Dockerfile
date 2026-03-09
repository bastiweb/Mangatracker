FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_FILE=/data/manga.db

EXPOSE 3000

VOLUME ["/data"]

CMD ["npm", "start"]
