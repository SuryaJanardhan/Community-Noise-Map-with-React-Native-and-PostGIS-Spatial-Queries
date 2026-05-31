FROM node:20-alpine

WORKDIR /app/api

COPY api/package*.json ./
RUN npm ci

COPY api ./

EXPOSE 3000

CMD ["npm", "start"]
