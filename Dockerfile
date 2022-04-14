FROM node

WORKDIR /
COPY package.json .
CMD npm i

COPY dist/**/* .
CMD 

