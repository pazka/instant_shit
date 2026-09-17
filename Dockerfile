FROM node:20-alpine

WORKDIR /
COPY ./package.json ./package-lock.json ./
RUN npm ci --omit=dev

COPY . .
# the image must always run with the production config (port 80, real limits)
RUN cp config.prod.json config.json

# npm is not needed at runtime; its bundled deps (tar) trip the CVE gate
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

ENV PORT=80
EXPOSE 80
ENV TITLE=QuickPaste

CMD ["node", "server.js"]
