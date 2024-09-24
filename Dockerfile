FROM node

WORKDIR /usr/src/app

USER node

COPY . .

EXPOSE $LIVERELOAD_PORT
EXPOSE $PROXY_PORT

CMD ["node", "src/index.js"]

LABEL org.opencontainers.image.source https://github.com/InsiderPie/http-reload-proxy
LABEL description="HTTP/1.1 Proxy server that auto-reloads HTML pages when files in a directory change."

