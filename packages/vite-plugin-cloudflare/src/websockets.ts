import { createHeaders } from "@remix-run/node-fetch-server";
import { coupleWebSocket } from "miniflare";
import { WebSocketServer } from "ws";
import { UNKNOWN_HOST } from "./shared";
import type { Miniflare, Response as MiniflareResponse } from "miniflare";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type * as vite from "vite";

/**
 * Handles 'upgrade' requests to the Vite HTTP server and forwards WebSocket events between the client and Worker environments.
 */
export function handleWebSocket(
	httpServer: vite.HttpServer,
	miniflare: Miniflare,
	entryWorkerName?: string
) {
	const nodeWebSocket = new WebSocketServer({ noServer: true });

	httpServer.on(
		"upgrade",
		async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
			// Socket errors crash Node.js if unhandled
			socket.on("error", () => socket.destroy());

			const rawHost = request.headers.host ?? UNKNOWN_HOST;
			const base = /^https?:\/\//i.test(rawHost)
				? rawHost
				: `http://${rawHost}`;
			const url = new URL(request.url ?? "", base);

			const isViteRequest =
				request.headers["sec-websocket-protocol"]?.startsWith("vite");
			const isSandboxRequest = hasSandboxOrigin(url.origin);

			// Ignore Vite HMR WebSockets but forward on all sandbox requests.
			if (isViteRequest && !isSandboxRequest) {
				return;
			}

			const headers = createHeaders(request);

			// When an entryWorkerName is provided we dispatch directly to the named
			// worker via `getWorker()` instead of going through `dispatchFetch()`.
			// `dispatchFetch()` routes through ViteProxyWorker whose `fetch` handler
			// forwards every request — including WebSocket upgrades — to the
			// `__VITE_MIDDLEWARE__` node service binding.  That binding only handles
			// plain HTTP (it wraps Vite's Connect middleware stack), so WebSocket
			// upgrades are silently discarded.  `getWorker(entryWorkerName).fetch()`
			// bypasses ViteProxyWorker entirely and talks directly to the user worker
			// via workerd's ProxyClient `Fetcher#fetch()`, which internally uses
			// `dispatchFetch()` and supports WebSocket upgrades.
			let response: MiniflareResponse;
			try {
				if (entryWorkerName) {
					const worker = await miniflare.getWorker(entryWorkerName);
					response = await worker.fetch(url, {
						headers,
						method: request.method,
					});
				} else {
					response = await miniflare.dispatchFetch(url, {
						headers,
						method: request.method,
					});
				}
			} catch {
				socket.destroy();
				return;
			}
			const workerWebSocket = response.webSocket;

			if (!workerWebSocket) {
				socket.destroy();
				return;
			}

			nodeWebSocket.handleUpgrade(
				request,
				socket,
				head,
				async (clientWebSocket) => {
					void coupleWebSocket(clientWebSocket, workerWebSocket);
					nodeWebSocket.emit("connection", clientWebSocket, request);
				}
			);
		}
	);
}

/**
 * Matches the origin of a Sandbox SDK preview URL.
 * See: https://developers.cloudflare.com/sandbox/concepts/preview-urls/
 *
 * Pattern: https?://<port(4+ digits)>-<id(no dots)>-<token>.localhost
 *
 * IMPORTANT: The token segment is [a-z0-9_]+ (no hyphens) to prevent ReDoS — two adjacent
 * [^.]+ groups separated by - cause quadratic backtracking on hyphen-heavy input. Tokens are
 * documented as letters/digits/underscores only.
 */
const SANDBOX_ORIGIN_REGEXP =
	/^https?:\/\/\d{4,}-[^.]+-[a-z0-9_]+\.localhost(:\d+)?$/i;

function hasSandboxOrigin(origin: string) {
	return SANDBOX_ORIGIN_REGEXP.test(origin);
}
