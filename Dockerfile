FROM node:22-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
ENV NODE_ENV=production DATA_DIR=/data TRUST_PROXY=1 PORT=3000
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
