import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import stream from "node:stream/promises";
import { MIMEType, debuglog } from "node:util";
import { once } from "node:events";

const log = debuglog("http-reload-proxy");

const upstreamHost = env("UPSTREAM_HOST")
const upstreamPort = envInt("UPSTREAM_PORT");
const livereloadPort = envInt("LIVERELOAD_PORT");
const livereloadDelay = envInt("LIVERELOAD_DELAY");
const proxyPort = envInt("PROXY_PORT");
const watchPath = env("WATCH_PATH");
const origin = process.env.ACCESS_CONTROL_ALLOW_ORIGIN || `http://localhost:${proxyPort}`;

const livereloadScript = `<script>
  const livereload = new EventSource("http://localhost:${livereloadPort}/");
  livereload.onmessage = () => {
    setTimeout(() => {
      location.reload();
    }, ${livereloadDelay});
  };
</script>`;
const livereloadScriptSHA256 = crypto.createHash("sha256")
  .update(livereloadScript)
  .digest("base64");

const livereloadClients = new Set();
const livereloadServer = http.createServer((request, response) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": origin,
  });
  livereloadClients.add(response);
  request.on("close", () => {
    livereloadClients.delete(response);
  });
}).listen(livereloadPort, () => {
  log(`Livereload server is listening on http://localhost:${livereloadPort}`);
});

const fsWatcher = fs.watch(watchPath, { recursive: true }, (event, filename) => {
  log(`File ${filename} has been ${event}d`);
  for (const client of livereloadClients) {
    client.write("data: update\n\n");
  }
});
log(`Watching ${watchPath} for changes`);

const proxyServer = http.createServer(async (downstreamRequest, downstreamResponse) => {
  try {
    /** @type {Promise<void>} */
    let proxyResponsePromise;
    const upstreamRequestOptions = createUpstreamRequestOptions(downstreamRequest);
    const upstreamRequest = http.request(upstreamRequestOptions, upstreamResponse => {
      proxyResponsePromise = sendProxyResponse(downstreamResponse, upstreamResponse);
    });
    await stream.pipeline(downstreamRequest, upstreamRequest);
    await proxyResponsePromise;
  } catch (error) {
    log(error);
    if (!downstreamResponse.headersSent) {
      downstreamResponse.writeHead(error.code === 'ECONNREFUSED' ? 502 : 500);
    }
    if (!downstreamResponse.writableEnded) {
      downstreamResponse.end();
    }
  }
}).listen(proxyPort, () => {
  log(`Livereload proxy is listening on http://localhost:${proxyPort} ` 
    + `and proxying to http://${upstreamHost}:${upstreamPort}`);
});

Promise.all([
  once(livereloadServer, "listening"),
  once(proxyServer, "listening"),
]).then(() => {
  process.send?.("listening");
});

process.on("SIGTERM", () => {
  log("Received SIGTERM, closing servers");
  process.send?.("closing");
  fsWatcher.close();
  proxyServer.close();
  livereloadServer.close();
  Promise.all([
    once(proxyServer, "close"),
    once(livereloadServer, "close"),
  ]).then(() => {
    log("Servers closed, exiting");
    process.send?.("close");
    process.exit(0);
  });
});

async function sendProxyResponse(response, proxyResponse) {
  const isHTML = isHTMLResponse(proxyResponse);
  if (!isHTML) {
    response.writeHead(proxyResponse.statusCode, proxyResponse.headers);
    await stream.pipeline(proxyResponse, response, { end: true });
    return;
  }

  const proxyHeaders = proxyResponse.headers;
  if (proxyHeaders["content-security-policy"]) {
    proxyHeaders["content-security-policy"] = addLiveReloadScriptToCSP(
      proxyHeaders["content-security-policy"]
    );
  }
  if (proxyHeaders["content-security-policy-report-only"]) {
    proxyHeaders["content-security-policy-report-only"] = addLiveReloadScriptToCSP(
      proxyHeaders["content-security-policy-report-only"]
    );
  }
  if (proxyHeaders["content-length"]) {
    proxyHeaders["content-length"] = 
      (parseInt(proxyHeaders["content-length"]) + livereloadScript.length)
      .toString();
  }
  response.writeHead(proxyResponse.statusCode, proxyHeaders);
  await stream.pipeline(proxyResponse, response, { end: false });
  response.end(livereloadScript);
}

/**
 * @param {string} csp
 * @returns {string}
 */
function addLiveReloadScriptToCSP(csp) {
  const liveReloadDirective = `'sha256-${livereloadScriptSHA256}'`;
  const cspDirectives = csp.split(";").map(directive => directive.trim());
  const scriptSrcDirective = cspDirectives.find(directive => directive.startsWith("script-src"));
  if (!scriptSrcDirective) {
    return csp + `; script-src ${liveReloadDirective}`;
  }
  const scriptSrcValues = scriptSrcDirective.split(" ").slice(1);
  if (scriptSrcValues.includes("'unsafe-inline'")) {
    return csp;
  }
  const scriptSrcValuesWithLiveReload = [...scriptSrcValues, liveReloadDirective];
  return csp.replace(scriptSrcDirective, `script-src ${scriptSrcValuesWithLiveReload.join(" ")}`);
}

/**
 * @param {http.IncomingMessage} response
 */
function isHTMLResponse(response) {
  const contentType = response.headers["content-type"];
  if (!contentType) {
    return false;
  }
  return new MIMEType(contentType).essence === "text/html";
}

/**
 * @param {http.IncomingMessage} request
 * @returns {http.RequestOptions}
 */
function createUpstreamRequestOptions(request) {
  return {
    protocol: "http:",
    auth: request.auth,
    hostname: upstreamHost,
    port: upstreamPort,
    path: request.url,
    headers: request.headers,
    method: request.method,
  };
}

function env(name) {
  if (!process.env[name]) {
    console.error(`Environment variable ${name} is required`);
    process.exit(1);
  }
  return process.env[name];
}

function envInt(name) {
  if (!process.env[name]) {
    console.error(`Environment variable ${name} is required and must be an integer`);
    process.exit(1);
  }
  if (isNaN(parseInt(process.env[name]))) {
    console.error(`Environment variable ${name} must be an integer`);
    process.exit(1);
  }
  return parseInt(process.env[name]);
}

