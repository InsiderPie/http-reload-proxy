import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import stream from "node:stream/promises";
import { MIMEType, debuglog } from "node:util";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";

const log = debuglog("http-reload-proxy");

const upstreamHost = env("UPSTREAM_HOST")
const upstreamPort = envInt("UPSTREAM_PORT");
const livereloadPort = envInt("LIVERELOAD_PORT");
const livereloadDelay = envInt("LIVERELOAD_DELAY");
const proxyPort = envInt("PROXY_PORT");
const watchPath = env("WATCH_PATH");
const origin = process.env.ACCESS_CONTROL_ALLOW_ORIGIN || `http://localhost:${proxyPort}`;
const upstreamRetries = parseInt(process.env.UPSTREAM_RETRIES) || 5;
const upstreamRetryDelay = parseInt(process.env.UPSTREAM_RETRY_DELAY) || 200;

const agent = new http.Agent({ keepAlive: false, noDelay: true });

const livereloadScript = Buffer.from(`<script>
	const livereload = new EventSource("http://localhost:${livereloadPort}/");
	livereload.onmessage = () => {
		setTimeout(() => {
			location.reload();
		}, ${livereloadDelay});
	};
</script>`, "utf-8");
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
		await handleRequest(downstreamRequest, downstreamResponse);
	} catch (error) {
		log(error);
		if (!downstreamResponse.headersSent) {
			downstreamResponse.writeHead(error.code === "ECONNREFUSED" ? 502 : 500);
		}
		if (!downstreamResponse.writableEnded) {
			downstreamResponse.end();
		}
	}
}).listen(proxyPort, () => {
	log(`Livereload proxy is listening on http://localhost:${proxyPort} `
		+ `and proxying to http://${upstreamHost}:${upstreamPort}`);
});

async function handleRequest(downstreamRequest, downstreamResponse, { retries = upstreamRetries } = {}) {
	try {
		const upstreamRequestOptions = createUpstreamRequestOptions(downstreamRequest);
		const upstreamRequestBody = await readBody(downstreamRequest);
		const upstreamResponse = await httpRequest(upstreamRequestOptions, upstreamRequestBody);
		await sendProxyResponse(downstreamResponse, upstreamResponse);
	} catch (error) {
		if (error.code === "ECONNREFUSED" && retries > 0) {
			log(`Retrying request to ${upstreamHost}:${upstreamPort}`);
			await setTimeout(upstreamRetryDelay);
			await handleRequest(downstreamRequest, downstreamResponse, { retries: retries - 1 });
		} else {
			throw error;
		}
	}
}

async function httpRequest(options, body) {
	return await new Promise((resolve, reject) => {
		http.request(options, response => resolve(response))
			.on("error", reject)
			.end(body);
	});
}

Promise.all([
	once(livereloadServer, "listening"),
	once(proxyServer, "listening"),
]).then(() => {
	process.send?.("listening");
});

/**
 * @param {import("node:stream").Readable} readable
 * @returns Buffer
 */
async function readBody(readable) {
	return Buffer.concat(await readable.toArray())
}

/**
 *
 * @param {http.ServerResponse} downstreamResponse
 * @param {http.IncomingMessage} upstreamResponse
 * @returns
 */
async function sendProxyResponse(downstreamResponse, upstreamResponse) {
	const responseBody = await readBody(upstreamResponse);

	const isHTML = isHTMLResponse(upstreamResponse);
	if (!isHTML) {
		downstreamResponse.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
		downstreamResponse.end(responseBody);
		return;
	}

	const proxyHeaders = upstreamResponse.headers;
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
	downstreamResponse.writeHead(upstreamResponse.statusCode, proxyHeaders);
	downstreamResponse.write(responseBody);
	downstreamResponse.end(livereloadScript);
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
		agent,
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

