FROM node:20-alpine

WORKDIR /app

COPY api/package.json ./api/package.json
RUN cd api && npm install

COPY api ./api

WORKDIR /app/api

EXPOSE 3000

CMD ["npm", "start"]
