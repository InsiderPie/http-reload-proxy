# http-reload-proxy

HTTP/1.1 Proxy server that auto-reloads HTML pages when files in a directory change.

## Usage

### from source

- Clone the repository
- Set the required environment variables (see [Configuration](#configuration))
- Run `node src/index.js`

### with docker



## Configuration

Configuration is done through environment variables. The following variables **must** be specified:

- `UPSTREAM_HOST`: The upstream hostname that requests are proxied to
- `UPSTREAM_PORT`: The upstream port that requests are proxied to
- `LIVERELOAD_PORT`: The port (on localhost) that the livereload server listens on
- `LIVERELOAD_DELAY`: The delay in milliseconds between receiving a file change notification and initiating a reload. Use this if your upstream server needs time to restart/reload after a file change. Set to 0 if no delay is required.
- `PROXY_PORT`: The port (on localhost) that the proxy server listens on
- `WATCH_PATH`: The directory to watch for changes. Any file change in this directory or any subdirectory will trigger a reload.

The following variables are optional:

- `NODE_DEBUG=http-reload-proxy`: This will enable verbose (debugging) output

## Example

```bash
UPSTREAM_HOST=localhost \
UPSTREAM_PORT=8000 \
LIVERELOAD_PORT=3300 \
LIVERELOAD_DELAY=250 \   
PROXY_PORT=3000 \
WATCH_PATH=/home/example/www \
node src/index.js
```

This will:
- start a livereload server on `http://localhost:3300` that responds to all request with a `text/event-stream` response
- start a proxy server on `http://localhost:3000` that forwards requests to `http://localhost:8000`
  - responses with type `text/html` will be modified as follows:
    - an inline `<script>` will be appended to the HTML that sets up an `EventSource` that connects to the livereload server and, if it receives any message, triggers a reload after `250` milliseconds
    - if the response has a `Content-Security-Policy[-Report-Only]` header, the hash of the inline script will be added as `script-src`
  - other responses will be passed through unchanged
- start a file system watcher using `fs.watch` that looks for changes in `/home/example/www` or any subdirectories and tells the livereload server to send an event to all clients when it detects any changes

## Limitations

- There is currently no support for proxying websockets connections.
- There is also no support for modifying a Content-Security-Policy that is specified in the HTML using a `<meta http-equiv="Content-Security-Policy" content="...">` tag.
- There is no support for certain HTML edge cases (e.g. if the HTML sent by the upstream ends with `<!--`, the livereload script will be part of a comment and will not run).
- There is currently no timeout functionality. The proxy will wait forever for the upstream to send a response.

## License

Apache-2.0 &copy; [InsiderPie](https://insiderpie.de)
