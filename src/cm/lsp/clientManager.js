import {
	LSPClient,
	LSPPlugin,
	languageServerExtensions,
} from "@codemirror/lsp-client";
import { MapMode } from "@codemirror/state";
import { ensureServerRunning } from "./serverLauncher";
import serverRegistry from "./serverRegistry";
import { createTransport } from "./transport";
import AcodeWorkspace from "./workspace";

function asArray(value) {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

function pluginKey(serverId, rootUri) {
	return `${serverId}::${rootUri || "__global__"}`;
}

function safeString(value) {
	return value != null ? String(value) : "";
}

export class LspClientManager {
	constructor(options = {}) {
		this.options = { ...options };
		this.#clients = new Map();
	}

	#clients;

	setOptions(next) {
		this.options = { ...this.options, ...next };
	}

	getActiveClients() {
		return Array.from(this.#clients.values());
	}

	async getExtensionsForFile(metadata) {
		const { uri, languageId, languageName, view, file, rootUri } = metadata;

		const effectiveLang = safeString(languageId || languageName).toLowerCase();
		if (!effectiveLang) return [];

		const servers = serverRegistry.getServersForLanguage(effectiveLang);
		if (!servers.length) return [];

		const lspExtensions = [];

		for (const server of servers) {
			let targetLanguageId = effectiveLang;
			if (server.resolveLanguageId) {
				try {
					const resolved = server.resolveLanguageId({
						languageId: effectiveLang,
						languageName,
						uri,
						file,
					});
					if (resolved) targetLanguageId = safeString(resolved);
				} catch (error) {
					console.warn(
						`LSP server ${server.id} failed to resolve language id for ${uri}`,
						error,
					);
				}
			}

			try {
				const clientState = await this.#ensureClient(server, {
					uri,
					file,
					view,
					languageId: targetLanguageId,
					rootUri,
				});
				const plugin = clientState.client.plugin(uri, targetLanguageId);
				clientState.attach(uri, view);
				lspExtensions.push(plugin);
			} catch (error) {
				if (error?.code === "LSP_SERVER_UNAVAILABLE") {
					console.info(
						`Skipping LSP client for ${server.id}: ${error.message}`,
					);
					continue;
				}
				console.error(
					`Failed to initialize LSP client for ${server.id}`,
					error,
				);
			}
		}

		return lspExtensions;
	}

	async formatDocument(metadata, options = {}) {
		const { uri, languageId, languageName, view, file } = metadata;
		const effectiveLang = safeString(languageId || languageName).toLowerCase();
		if (!effectiveLang || !view) return false;
		const servers = serverRegistry.getServersForLanguage(effectiveLang);
		if (!servers.length) return false;

		for (const server of servers) {
			try {
				const context = {
					uri,
					languageId: effectiveLang,
					languageName,
					view,
					file,
					rootUri: metadata.rootUri,
				};
				const state = await this.#ensureClient(server, context);
				const capabilities = state.client.serverCapabilities;
				if (!capabilities?.documentFormattingProvider) continue;
				const plugin = LSPPlugin.get(view);
				if (!plugin) continue;
				plugin.client.sync();
				const edits = await state.client.request("textDocument/formatting", {
					textDocument: { uri },
					options,
				});
				if (!edits || !edits.length) continue;
				const applied = applyTextEdits(plugin, view, edits);
				if (applied) {
					plugin.client.sync();
					return true;
				}
			} catch (error) {
				console.error(`LSP formatting failed for ${server.id}`, error);
			}
		}
		return false;
	}

	detach(uri, view) {
		for (const state of this.#clients.values()) {
			state.detach(uri, view);
		}
	}

	async dispose() {
		const disposeOps = [];
		for (const [key, state] of this.#clients.entries()) {
			disposeOps.push(state.dispose?.());
			this.#clients.delete(key);
		}
		await Promise.allSettled(disposeOps);
	}

	async #ensureClient(server, context) {
		const rootUri = await this.#resolveRootUri(server, context);
		const key = pluginKey(server.id, rootUri);
		if (this.#clients.has(key)) {
			return this.#clients.get(key);
		}

		const workspaceOptions = {
			displayFile: this.options.displayFile,
		};

		const clientConfig = { ...(server.clientConfig || {}) };

		const extraExtensions = asArray(this.options.clientExtensions);
		const serverExtensions = asArray(clientConfig.extensions);
		const builtinExtensions = languageServerExtensions();
		const wantsCustomDiagnostics = [
			...extraExtensions,
			...serverExtensions,
		].some(
			(ext) => !!ext?.clientCapabilities?.textDocument?.publishDiagnostics,
		);
		const mergedExtensions = [
			...(wantsCustomDiagnostics
				? builtinExtensions.filter(
						(ext) => !ext?.clientCapabilities?.textDocument?.publishDiagnostics,
					)
				: builtinExtensions),
			...extraExtensions,
			...serverExtensions,
		];
		clientConfig.extensions = mergedExtensions;

		const existingHandlers = clientConfig.notificationHandlers || {};
		clientConfig.notificationHandlers = {
			...existingHandlers,
			"window/logMessage": (_client, params) => {
				if (!params?.message) return false;
				const { type, message } = params;
				let level = "info";
				switch (type) {
					case 1:
						level = "error";
						break;
					case 2:
						level = "warn";
						break;
					case 4:
						level = "log";
						break;
					default:
						level = "info";
				}
				(console[level] || console.info)(`[LSP:${server.id}] ${message}`);
				return true;
			},
			"window/showMessage": (_client, params) => {
				if (!params?.message) return false;
				console.info(`[LSP:${server.id}] ${params.message}`);
				return true;
			},
		};

		if (!clientConfig.workspace) {
			clientConfig.workspace = (client) =>
				new AcodeWorkspace(client, workspaceOptions);
		}

		if (rootUri && !clientConfig.rootUri) {
			clientConfig.rootUri = rootUri;
		}

		if (server.startupTimeout && !clientConfig.timeout) {
			clientConfig.timeout = server.startupTimeout;
		}

		let transportHandle;
		let client;

		try {
			await ensureServerRunning(server);
			transportHandle = createTransport(server, {
				...context,
				rootUri,
			});
			await transportHandle.ready;
			client = new LSPClient(clientConfig);
			client.connect(transportHandle.transport);
			await client.initializing;
			if (!client.__acodeLoggedInfo) {
				const info = client.serverInfo;
				if (info) {
					console.info(`[LSP:${server.id}] server info`, info);
				}
				if (rootUri) {
					console.info(`[LSP:${server.id}] root`, rootUri);
				}
				client.__acodeLoggedInfo = true;
			}
		} catch (error) {
			transportHandle?.dispose?.();
			throw error;
		}

		const state = this.#createClientState({
			key,
			server,
			client,
			transportHandle,
			rootUri,
		});

		this.#clients.set(key, state);
		return state;
	}

	#createClientState({ key, server, client, transportHandle, rootUri }) {
		const fileRefs = new Map();

		const attach = (uri, view) => {
			const existing = fileRefs.get(uri) || new Set();
			existing.add(view);
			fileRefs.set(uri, existing);
			const suffix = rootUri ? ` (root ${rootUri})` : "";
			console.info(`[LSP:${server.id}] attached to ${uri}${suffix}`);
		};

		const detach = (uri, view) => {
			const existing = fileRefs.get(uri);
			if (!existing) return;
			if (view) existing.delete(view);
			if (!view || !existing.size) {
				fileRefs.delete(uri);
				try {
					client.workspace?.closeFile?.(uri, view);
				} catch (error) {
					console.warn(`Failed to close LSP file ${uri}`, error);
				}
			}

			if (!fileRefs.size) {
				this.options.onClientIdle?.({ server, client, rootUri });
			}
		};

		const dispose = async () => {
			try {
				client.disconnect();
			} catch (error) {
				console.warn(`Error disconnecting LSP client ${server.id}`, error);
			}
			try {
				await transportHandle.dispose?.();
			} catch (error) {
				console.warn(`Error disposing LSP transport ${server.id}`, error);
			}
			this.#clients.delete(key);
		};

		return {
			server,
			client,
			transport: transportHandle,
			rootUri,
			attach,
			detach,
			dispose,
		};
	}

	async #resolveRootUri(server, context) {
		if (context?.rootUri) return context.rootUri;

		if (typeof server.rootUri === "function") {
			try {
				const value = await server.rootUri(context?.uri, context);
				if (value) return safeString(value);
			} catch (error) {
				console.warn(`Server root resolver failed for ${server.id}`, error);
			}
		}

		if (typeof this.options.resolveRoot === "function") {
			try {
				const value = await this.options.resolveRoot(context);
				if (value) return safeString(value);
			} catch (error) {
				console.warn("Global LSP root resolver failed", error);
			}
		}

		return null;
	}
}

function applyTextEdits(plugin, view, edits) {
	const changes = [];
	for (const edit of edits) {
		if (!edit?.range) continue;
		let fromBase;
		let toBase;
		try {
			fromBase = plugin.fromPosition(edit.range.start, plugin.syncedDoc);
			toBase = plugin.fromPosition(edit.range.end, plugin.syncedDoc);
		} catch (_) {
			continue;
		}
		const from = plugin.unsyncedChanges.mapPos(fromBase, 1, MapMode.TrackDel);
		const to = plugin.unsyncedChanges.mapPos(toBase, -1, MapMode.TrackDel);
		if (from == null || to == null) continue;
		const insert =
			typeof edit.newText === "string"
				? edit.newText.replace(/\r\n/g, "\n")
				: "";
		changes.push({ from, to, insert });
	}
	if (!changes.length) return false;
	changes.sort((a, b) => a.from - b.from || a.to - b.to);
	view.dispatch({ changes });
	return true;
}

const defaultManager = new LspClientManager();

export default defaultManager;
