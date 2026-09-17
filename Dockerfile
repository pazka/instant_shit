FROM node

WORKDIR /
COPY ./package.json ./package-lock.json ./
RUN npm ci --omit=dev

COPY . .
# the image must always run with the production config (port 80, real limits)
RUN cp config.prod.json config.json

ENV PORT 80
EXPOSE 80
ENV TITLE QuickPaste

CMD ["npm", "start"]
