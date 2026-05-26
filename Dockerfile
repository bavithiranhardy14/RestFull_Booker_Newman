FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=optional

COPY . .

RUN mkdir -p newman/reports newman/logs

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "trigger:start"]
