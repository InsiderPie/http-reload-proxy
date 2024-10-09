import child_process from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

/** @type {child_process.ChildProcess} */
let proxy;
/** @type {http.Server} */
let upstream;

test.before(async () => {
  upstream = http.createServer();
  upstream.listen(9081);
  await once(upstream, "listening");

  proxy = child_process.fork("src/index.js", {
    env: {
      UPSTREAM_HOST: "localhost",
      UPSTREAM_PORT: "9081",
      LIVERELOAD_PORT: "9082",
      LIVERELOAD_DELAY: "0",
      PROXY_PORT: "9080",
      WATCH_PATH: "tmp",
    },
  });
  await once(proxy, "message");
});

test.after(() => {
  if (proxy.exitCode === null) {
    proxy.kill();
  }
  if (upstream.listening) {
    upstream.close();
  }
});

/**
 * @param {http.RequestListener} listener
 */
function setUpstreamBehavior(listener) {
  upstream.removeAllListeners("request");
  upstream.on("request", listener);
}

test("proxy server should proxy non-HTML responses without modification", async () => {
  setUpstreamBehavior((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Hello, world!");
  });
  const response = await fetch("http://localhost:9080/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain");
  const text = await response.text();
  assert.equal(text, "Hello, world!");
});

test("proxy server should inject livereload script into HTML responses", async () => {
  setUpstreamBehavior((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>Hello, world!</body></html>");
  });

  const response = await fetch("http://localhost:9080/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html");
  const text = await response.text();
  assert.match(text, /<script>[\s\S]+<\/script>/);
  assert.match(text, /new EventSource\("http:\/\/localhost:9082\/"\)/);
});

test("proxy server should change the upstream csp header if it does not have a script-src", async () => {
  setUpstreamBehavior((request, response) => {
    response.writeHead(200, { 
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'"
    });
    response.end("<html><body>Hello, world!</body></html>");
  });

  const response = await fetch("http://localhost:9080/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), 
  "default-src 'self'; script-src 'sha256-dRzwlBsTdt31jik2aQY6AdmBBL8Fj0b/UoxTxHlLAJQ='");
});

test("proxy server should change the upstream csp header if it has a script-src", async () => {
  setUpstreamBehavior((request, response) => {
    response.writeHead(200, { 
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'; script-src 'self' https://js.example.com; style-src 'self' https://css.example.com"
    });
    response.end("<html><body>Hello, world!</body></html>");
  });

  const response = await fetch("http://localhost:9080/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), 
  "default-src 'self'; script-src 'self' https://js.example.com 'sha256-dRzwlBsTdt31jik2aQY6AdmBBL8Fj0b/UoxTxHlLAJQ='; style-src 'self' https://css.example.com");
});

test("proxy server should not change the upstream csp header if it has script-src 'unsafe-inline'", async () => {
  setUpstreamBehavior((request, response) => {
    response.writeHead(200, { 
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' https://css.example.com"
    });
    response.end("<html><body>Hello, world!</body></html>");
  });

  const response = await fetch("http://localhost:9080/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), 
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' https://css.example.com");
});

test("proxy server should change the upstream content-length header", async () => {
  setUpstreamBehavior((request, response) => {
    const html = "<html><body>Hello, world!</body></html>";
    response.writeHead(200, { "content-type": "text/html", "content-length": html.length.toString() });
    response.end(html);
  });

  const response = await fetch("http://localhost:9080/");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(response.headers.get("content-length"), text.length.toString());
});

test("proxy server should return 502 if the upstream server is down", async () => {
  upstream.close();
  const response = await fetch("http://localhost:9080/");
  assert.equal(response.status, 502);
});

test("livereload server should send update message to clients when a file changes", async context => {
  const client = new EventSource("http://localhost:9082/");
  context.after(() => client.close());
  const messagePromise = new Promise((resolve, reject) => {
    client.onmessage = resolve;
    client.onerror = reject;
  });
  await fs.writeFile("tmp/time.txt", new Date().toISOString());
  const message = await messagePromise;
  assert.equal(message.data, "update");
});

test("livereload server should detect changes in subdirectories", async context => {
  const client = new EventSource("http://localhost:9082/");
  context.after(() => client.close());
  const messagePromise = new Promise((resolve, reject) => {
    client.onmessage = resolve;
    client.onerror = reject;
  });
  await fs.mkdir("tmp/subdir", { recursive: true });
  await fs.writeFile("tmp/subdir/time.txt", new Date().toISOString());
  const message = await messagePromise;
  assert.equal(message.data, "update");
});

test("livereload server should detect when a file is renamed", async context => {
  const client = new EventSource("http://localhost:9082/");
  context.after(() => client.close());
  const messagePromise = new Promise((resolve, reject) => {
    client.onmessage = resolve;
    client.onerror = reject;
  });
  await fs.rename("tmp/time.txt", "tmp/renamed.txt");
  const message = await messagePromise;
  assert.equal(message.data, "update");
});

test("livereload server should detect renames in subdirectories", async context => {
  const client = new EventSource("http://localhost:9082/");
  context.after(() => client.close());
  const messagePromise = new Promise((resolve, reject) => {
    client.onmessage = resolve;
    client.onerror = reject;
  });
  await fs.rename("tmp/subdir/time.txt", "tmp/subdir/renamed.txt");
  const message = await messagePromise;
  assert.equal(message.data, "update");
});

test("livereload server should close when it gets a SIGTERM signal", async () => {
  const ok = proxy.kill("SIGTERM");
  assert.ok(ok);
  const [closingMessage] = await once(proxy, "message");
  assert.equal(closingMessage, "closing");
  const [closeMessage] = await once(proxy, "message");
  assert.equal(closeMessage, "close");
  await once(proxy, "close");
});
