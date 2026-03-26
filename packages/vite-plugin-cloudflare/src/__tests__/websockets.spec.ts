import http from "node:http";
import net from "node:net";
import { DeferredPromise, Miniflare, Response } from "miniflare";
import { afterEach, assert, beforeEach, describe, test, vi } from "vitest";
import { handleWebSocket } from "../websockets";
import type { AddressInfo } from "node:net";

const WORKER_SCRIPT = `export default {
	fetch() {
		const [client, server] = Object.values(new WebSocketPair());
		server.accept();
		return new Response(null, { status: 101, webSocket: client });
	}
}`;

describe("handleWebSocket (no entryWorkerName — uses dispatchFetch)", () => {
	let httpServer: http.Server;
	let miniflare: Miniflare;
	let port: number;

	beforeEach(async () => {
		httpServer = http.createServer((_req, res) => res.end("OK"));
		miniflare = new Miniflare({ modules: true, script: WORKER_SCRIPT });
		handleWebSocket(httpServer, miniflare);
		await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
		port = (httpServer.address() as AddressInfo).port;
	});

	afterEach(async () => {
		await miniflare?.dispose();
		await new Promise<void>((resolve, reject) =>
			httpServer?.close((e) => (e ? reject(e) : resolve()))
		);
	});

	// https://github.com/cloudflare/workers-sdk/issues/12047
	test("survives client disconnect during upgrade", async ({ expect }) => {
		// Mock dispatchFetch to simulate a slow response - the bug occurs when
		// the client disconnects while dispatchFetch is pending
		const deferred = new DeferredPromise<Response>();
		vi.spyOn(miniflare, "dispatchFetch").mockReturnValue(deferred);

		const socket = net.connect(port, "127.0.0.1");
		await new Promise<void>((r) => socket.on("connect", r));
		socket.write(
			"GET / HTTP/1.1\r\n" +
				"Host: localhost\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
				"Sec-WebSocket-Version: 13\r\n\r\n"
		);

		// Reset connection while dispatchFetch is pending, triggering ECONNRESET
		socket.resetAndDestroy();

		// Resolve the mock so miniflare.dispose() doesn't hang in afterEach
		deferred.resolve(new Response(null));

		// Verify server did not crash and is still responsive
		const response = await fetch(`http://127.0.0.1:${port}`);
		expect(response.ok).toBe(true);
	});

	test("forwards sandbox requests", async ({ expect }) => {
		const deferred = new DeferredPromise<Response>();
		const mockedDispatchFetch = vi
			.spyOn(miniflare, "dispatchFetch")
			.mockReturnValue(deferred);

		const socket = net.connect(port, "127.0.0.1");
		await new Promise<void>((r) => socket.on("connect", r));
		socket.write(
			"GET / HTTP/1.1\r\n" +
				`Host: 4567-my-sandbox-sup3rs3cr3t.localhost:${port}\r\n` +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
				"Sec-WebSocket-Protocol: vite-hmr\r\n" +
				"Sec-WebSocket-Version: 13\r\n\r\n"
		);

		await vi.waitFor(() => expect(miniflare.dispatchFetch).toHaveBeenCalled());

		// Resolve the mock so miniflare.dispose() doesn't hang in afterEach
		deferred.resolve(new Response(null));

		assert(mockedDispatchFetch.mock.lastCall);
		const [url, init] = mockedDispatchFetch.mock.lastCall;

		assert(init);
		expect(`${url}`).toBe(
			`http://4567-my-sandbox-sup3rs3cr3t.localhost:${port}/`
		);
		expect(init.method).toBe("GET");

		assert(
			init.headers instanceof Headers,
			"Test expects headers object passed to dispatchFetch to be Headers instance"
		);
		expect(init.headers.get("host")).toBe(
			`4567-my-sandbox-sup3rs3cr3t.localhost:${port}`
		);
		expect(init.headers.get("upgrade")).toBe("websocket");
		expect(init.headers.get("connection")).toBe("Upgrade");
		expect(init.headers.get("sec-websocket-key")).toBe(
			"dGhlIHNhbXBsZSBub25jZQ=="
		);
		expect(init.headers.get("sec-websocket-protocol")).toBe("vite-hmr");
		expect(init.headers.get("sec-websocket-version")).toBe("13");
	});
});

describe("handleWebSocket (with entryWorkerName — uses getWorker)", () => {
	const WORKER_NAME = "my-worker";
	let httpServer: http.Server;
	let miniflare: Miniflare;
	let port: number;

	beforeEach(async () => {
		httpServer = http.createServer((_req, res) => res.end("OK"));
		miniflare = new Miniflare({
			workers: [{ name: WORKER_NAME, modules: true, script: WORKER_SCRIPT }],
		});
		handleWebSocket(httpServer, miniflare, WORKER_NAME);
		await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
		port = (httpServer.address() as AddressInfo).port;
	});

	afterEach(async () => {
		await miniflare?.dispose();
		await new Promise<void>((resolve, reject) =>
			httpServer?.close((e) => (e ? reject(e) : resolve()))
		);
	});

	test("uses getWorker().fetch() and does not call dispatchFetch for the upgrade itself", async ({
		expect,
	}) => {
		// getWorker(name).fetch() internally calls dispatchFetch with ProxyServer
		// operation headers (OP, OP_TARGET, OP_KEY) — but critically it does NOT
		// route through ViteProxyWorker's fetch(), which would forward to the
		// __VITE_MIDDLEWARE__ node service binding and silently discard upgrades.
		// We verify this by spying on getWorker and confirming it is called with
		// the correct name, and that the upgrade response is 101.
		const getWorkerSpy = vi.spyOn(miniflare, "getWorker");

		// Send a real WebSocket upgrade request
		const socket = net.connect(port, "127.0.0.1");
		await new Promise<void>((r) => socket.on("connect", r));
		socket.write(
			"GET /ws HTTP/1.1\r\n" +
				"Host: localhost\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
				"Sec-WebSocket-Version: 13\r\n\r\n"
		);

		// Wait for the upgrade response (101 Switching Protocols)
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for 101 response")),
				5_000
			);
			socket.on("data", (data) => {
				if (data.toString().includes("101")) {
					clearTimeout(timer);
					resolve();
				}
			});
			socket.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
		socket.destroy();

		expect(getWorkerSpy).toHaveBeenCalledWith(WORKER_NAME);
	});

	test("WebSocket upgrade through getWorker() succeeds end-to-end", async ({
		expect,
	}) => {
		// Verify the server is alive and the WebSocket handshake completes
		const socket = net.connect(port, "127.0.0.1");
		await new Promise<void>((r) => socket.on("connect", r));
		socket.write(
			"GET /ws HTTP/1.1\r\n" +
				"Host: localhost\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
				"Sec-WebSocket-Version: 13\r\n\r\n"
		);

		const responseData = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for upgrade response")),
				5_000
			);
			let data = "";
			socket.on("data", (chunk) => {
				data += chunk.toString();
				// Once we have the full status line we can check it
				if (data.includes("\r\n\r\n") || data.includes("101")) {
					clearTimeout(timer);
					resolve(data);
				}
			});
			socket.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
		socket.destroy();

		expect(responseData).toContain("101 Switching Protocols");
	});
});
