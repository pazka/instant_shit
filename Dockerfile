FROM node

WORKDIR /
COPY package.json .
CMD npm i

COPY dist/**/* .

ENV PORT 80
ENV TITLE Coppa

CMD npm start