/*
	Language servers that expose stdio are proxied through a lightweight
	WebSocket bridge so the CodeMirror client can continue to speak WebSocket.
*/

/**
 * @typedef {Object} TransportHandle
 * @property {{ send(message: string): void, subscribe(handler: (value: string) => void): void, unsubscribe(handler: (value: string) => void): void }} transport
 * @property {() => Promise<void> | void} dispose
 * @property {Promise<void>} ready
 */

function createWebSocketTransport(server, context) {
	const { url, options = {} } = server.transport;
	if (!url) {
		throw new Error(`WebSocket transport for ${server.id} is missing a url`);
	}

	let socket;
	try {
		// pylsp's websocket endpoint does not require subprotocol negotiation.
		// Avoid passing protocols to keep the handshake simple.
		socket = new WebSocket(url);
	} catch (error) {
		throw new Error(
			`Failed to construct WebSocket for ${server.id} (${url}): ${error?.message || error}`,
		);
	}
	const listeners = new Set();
	const binaryMode = !!options.binary;
	if (binaryMode) {
		socket.binaryType = "arraybuffer";
	}

	const ready = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.onopen = socket.onerror = null;
			try {
				socket.close();
			} catch (_) {}
			reject(new Error(`Timed out opening WebSocket for ${server.id}`));
		}, 5000);
		socket.onopen = () => {
			clearTimeout(timeout);
			socket.onopen = socket.onerror = null;
			resolve();
		};
		socket.onerror = (event) => {
			clearTimeout(timeout);
			socket.onopen = socket.onerror = null;
			const reason = event?.message || event?.type || "connection error";
			reject(new Error(`WebSocket error for ${server.id}: ${reason}`));
		};
	});

	socket.onmessage = async (event) => {
		let data;
		if (typeof event.data === "string") {
			data = event.data;
		} else if (event.data instanceof Blob) {
			data = await event.data.text();
		} else if (event.data instanceof ArrayBuffer) {
			data = new TextDecoder().decode(event.data);
		} else {
			console.warn(
				"Unknown WebSocket message type",
				typeof event.data,
				event.data,
			);
			data = String(event.data);
		}
		// Debugging aid while stabilising websocket transport
		if (context?.debugWebSocket) {
			console.debug(`[LSP:${server.id}] <=`, data);
		}
		listeners.forEach((listener) => {
			try {
				listener(data);
			} catch (error) {
				console.error("LSP transport listener failed", error);
			}
		});
	};

	const encoder = binaryMode ? new TextEncoder() : null;
	const transport = {
		send(message) {
			if (socket.readyState !== WebSocket.OPEN) {
				throw new Error("WebSocket transport is not open");
			}
			if (binaryMode) {
				socket.send(encoder.encode(message));
			} else {
				socket.send(message);
			}
		},
		subscribe(handler) {
			listeners.add(handler);
		},
		unsubscribe(handler) {
			listeners.delete(handler);
		},
	};

	const dispose = () => {
		listeners.clear();
		if (
			socket.readyState === WebSocket.CLOSED ||
			socket.readyState === WebSocket.CLOSING
		) {
			return;
		}
		socket.close(1000, "Client disposed");
	};

	return { transport, dispose, ready };
}

function createStdioTransport(server, context) {
	if (!server.transport?.url) {
		throw new Error(
			`STDIO transport for ${server.id} is missing a websocket bridge url`,
		);
	}
	if (!server.transport?.options?.binary) {
		console.info(
			`LSP server ${server.id} is using stdio bridge without binary mode. Falling back to text frames.`,
		);
	}
	return createWebSocketTransport(server, context);
}

export function createTransport(server, context = {}) {
	switch (server.transport.kind) {
		case "websocket":
			return createWebSocketTransport(server, context);
		case "stdio":
			return createStdioTransport(server, context);
		case "external":
			if (typeof server.transport.create === "function") {
				return server.transport.create(server, context);
			}
			throw new Error(
				`LSP server ${server.id} declares an external transport without a create() factory`,
			);
		default:
			throw new Error(`Unsupported transport kind: ${server.transport.kind}`);
	}
}

export default { createTransport };
