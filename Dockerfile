FROM node

WORKDIR /usr/src/app

USER node

COPY . .

EXPOSE $LIVERELOAD_PORT
EXPOSE $PROXY_PORT

CMD ["node", "src/index.js"]
