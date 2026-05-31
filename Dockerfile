FROM node:20

WORKDIR /app/api

COPY api/package*.json ./
RUN npm install --omit=dev

COPY api ./

EXPOSE 3000

CMD ["npm", "start"]
