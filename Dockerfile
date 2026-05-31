FROM node:20-alpine

WORKDIR /app

COPY api/package*.json ./api/
RUN cd api && npm ci

COPY api ./api

WORKDIR /app/api

EXPOSE 3000

CMD ["npm", "start"]
