FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --only=production

COPY . .

RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "index.js"]
