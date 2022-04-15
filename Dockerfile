FROM node

WORKDIR /
COPY ./package.json .
RUN npm i

COPY . .

ENV PORT 80
EXPOSE 80
ENV TITLE QuickPaste

CMD ["npm", "start"]