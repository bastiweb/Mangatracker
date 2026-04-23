FROM node:25-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3003
ENV DB_FILE=/data/manga.db

EXPOSE 3003

VOLUME ["/data"]

CMD ["npm", "start"]


