FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

WORKDIR /
COPY ./package.json ./package-lock.json ./
RUN npm ci --omit=dev

COPY . .
# the image must always run with the production config (port 80, real limits)
RUN cp config.prod.json config.json

# npm is not needed at runtime; its bundled deps (tar) trip the CVE gate
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

# /data: bind mount on the legacy box compose (uid 1000), named volume instantshit-data with hosh-deploy
# (uid 10001). An EMPTY named volume takes this dir's owner and mode on every mount, so 1777 lets any
# non-root uid start on a fresh volume; the server creates tmp/ and the data files as the running uid.
RUN mkdir /data && chown 10001:10001 /data && chmod 1777 /data

# PORT=80 keeps the legacy compose working; hosh-deploy's compose sets PORT=8000
ENV PORT=80
EXPOSE 80
ENV TITLE=QuickPaste
ENV DATA_DIR=/data

# GET /healthz proves the data dir is writable (no curl/wget needed: node's fetch)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
