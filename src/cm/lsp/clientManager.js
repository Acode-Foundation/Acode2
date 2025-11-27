import { getIndentUnit, indentUnit } from "@codemirror/language";
import {
	findReferencesKeymap,
	formatKeymap,
	hoverTooltips,
	jumpToDefinitionKeymap,
	LSPClient,
	LSPPlugin,
	renameKeymap,
	serverCompletion,
	serverDiagnostics,
	signatureHelp,
} from "@codemirror/lsp-client";
import { MapMode } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import Uri from "utils/Uri";
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

const defaultKeymaps = keymap.of([
	...formatKeymap,
	...renameKeymap,
	...jumpToDefinitionKeymap,
	...findReferencesKeymap,
]);

function buildBuiltinExtensions({
	includeHover = true,
	includeCompletion = true,
	includeSignature = true,
	includeKeymaps = true,
	includeDiagnostics = true,
} = {}) {
	const extensions = [];
	let diagnosticsExtension = null;

	if (includeCompletion) extensions.push(serverCompletion());
	if (includeHover) extensions.push(hoverTooltips());
	if (includeKeymaps) extensions.push(defaultKeymaps);
	if (includeSignature) extensions.push(signatureHelp());
	if (includeDiagnostics) {
		diagnosticsExtension = serverDiagnostics();
		extensions.push(diagnosticsExtension);
	}

	return { extensions, diagnosticsExtension };
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
		const diagnosticsUiExtension = this.options.diagnosticsUiExtension;

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

		if (diagnosticsUiExtension && lspExtensions.length) {
			lspExtensions.push(...asArray(diagnosticsUiExtension));
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
				state.attach(uri, view);
				const plugin = LSPPlugin.get(view);
				if (!plugin) continue;
				plugin.client.sync();
				const edits = await state.client.request("textDocument/formatting", {
					textDocument: { uri },
					options: buildFormattingOptions(view, options),
				});
				if (!edits || !edits.length) {
					plugin.client.sync();
					return true;
				}
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
		const resolvedRoot = await this.#resolveRootUri(server, context);
		const { normalizedRootUri, originalRootUri } = normalizeRootUriForServer(
			server,
			resolvedRoot,
		);
		const key = pluginKey(server.id, normalizedRootUri);
		if (this.#clients.has(key)) {
			return this.#clients.get(key);
		}

		const workspaceOptions = {
			displayFile: this.options.displayFile,
		};

		const clientConfig = { ...(server.clientConfig || {}) };
		const builtinConfig = clientConfig.builtinExtensions || {};
		const useDefaultExtensions = clientConfig.useDefaultExtensions !== false;
		const { extensions: defaultExtensions, diagnosticsExtension } =
			useDefaultExtensions
				? buildBuiltinExtensions({
						includeHover: builtinConfig.hover !== false,
						includeCompletion: builtinConfig.completion !== false,
						includeSignature: builtinConfig.signature !== false,
						includeKeymaps: builtinConfig.keymaps !== false,
						includeDiagnostics: builtinConfig.diagnostics !== false,
					})
				: { extensions: [], diagnosticsExtension: null };

		const extraExtensions = asArray(this.options.clientExtensions);
		const serverExtensions = asArray(clientConfig.extensions);
		const wantsCustomDiagnostics = [
			...extraExtensions,
			...serverExtensions,
		].some(
			(ext) => !!ext?.clientCapabilities?.textDocument?.publishDiagnostics,
		);

		const filteredBuiltins =
			wantsCustomDiagnostics && diagnosticsExtension
				? defaultExtensions.filter((ext) => ext !== diagnosticsExtension)
				: defaultExtensions;

		const mergedExtensions = [
			...filteredBuiltins,
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

		if (normalizedRootUri && !clientConfig.rootUri) {
			clientConfig.rootUri = normalizedRootUri;
		}

		if (!normalizedRootUri && clientConfig.rootUri) {
			delete clientConfig.rootUri;
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
				rootUri: normalizedRootUri ?? null,
				originalRootUri,
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
				if (normalizedRootUri) {
					if (originalRootUri && originalRootUri !== normalizedRootUri) {
						console.info(
							`[LSP:${server.id}] root ${normalizedRootUri} (from ${originalRootUri})`,
						);
					} else {
						console.info(`[LSP:${server.id}] root`, normalizedRootUri);
					}
				} else if (originalRootUri) {
					console.info(`[LSP:${server.id}] root ignored`, originalRootUri);
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
			normalizedRootUri,
			originalRootUri,
		});

		this.#clients.set(key, state);
		return state;
	}

	#createClientState({
		key,
		server,
		client,
		transportHandle,
		normalizedRootUri,
		originalRootUri,
	}) {
		const fileRefs = new Map();
		const effectiveRoot = normalizedRootUri ?? originalRootUri ?? null;

		const attach = (uri, view) => {
			const existing = fileRefs.get(uri) || new Set();
			existing.add(view);
			fileRefs.set(uri, existing);
			const suffix = effectiveRoot ? ` (root ${effectiveRoot})` : "";
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
				this.options.onClientIdle?.({
					server,
					client,
					rootUri: effectiveRoot,
				});
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
			rootUri: effectiveRoot,
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

function buildFormattingOptions(view, overrides = {}) {
	const state = view?.state;
	if (!state) return { ...overrides };

	const unitValue = state.facet(indentUnit);
	const unit =
		typeof unitValue === "string" && unitValue.length
			? unitValue
			: String(unitValue || "\t");
	let tabSize = getIndentUnit(state);
	if (
		typeof tabSize !== "number" ||
		!Number.isFinite(tabSize) ||
		tabSize <= 0
	) {
		tabSize = resolveIndentWidth(unit);
	}
	const insertSpaces = !unit.includes("\t");

	return {
		tabSize,
		insertSpaces,
		...overrides,
	};
}

function resolveIndentWidth(unit) {
	if (typeof unit !== "string" || !unit.length) return 4;
	let width = 0;
	for (const ch of unit) {
		if (ch === "\t") return 4;
		width += 1;
	}
	return width || 4;
}

const defaultManager = new LspClientManager();

export default defaultManager;

const FILE_SCHEME_REQUIRED_SERVERS = new Set(["typescript"]);

function normalizeRootUriForServer(server, rootUri) {
	if (!rootUri || typeof rootUri !== "string") {
		return { normalizedRootUri: null, originalRootUri: null };
	}
	const schemeMatch = /^([a-zA-Z][\w+\-.]*):/.exec(rootUri);
	const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
	if (scheme === "file") {
		return { normalizedRootUri: rootUri, originalRootUri: rootUri };
	}

	if (scheme === "content") {
		const fileUri = contentUriToFileUri(rootUri);
		if (fileUri) {
			return { normalizedRootUri: fileUri, originalRootUri: rootUri };
		}
		if (FILE_SCHEME_REQUIRED_SERVERS.has(server.id)) {
			return { normalizedRootUri: null, originalRootUri: rootUri };
		}
	}

	return { normalizedRootUri: rootUri, originalRootUri: rootUri };
}

function contentUriToFileUri(uri) {
	try {
		const parsed = Uri.parse(uri);
		if (!parsed || typeof parsed !== "object") return null;
		const { docId, rootUri, isFileUri } = parsed;
		if (!docId) return null;

		if (isFileUri && rootUri) {
			return rootUri;
		}

		const providerMatch =
			/^content:\/\/com\.((?![:<>"/\\|?*]).*)\.documents\//.exec(rootUri);
		const providerId = providerMatch ? providerMatch[1] : null;

		let normalized = docId.trim();
		if (!normalized) return null;

		switch (providerId) {
			case "foxdebug.acode":
				normalized = normalized.replace(/:+$/, "");
				if (!normalized) return null;
				if (normalized.startsWith("raw:/")) {
					normalized = normalized.slice(4);
				} else if (normalized.startsWith("raw:")) {
					normalized = normalized.slice(4);
				}
				if (!normalized.startsWith("/")) return null;
				return buildFileUri(normalized);
			case "android.externalstorage":
				normalized = normalized.replace(/:+$/, "");
				if (!normalized) return null;

				if (normalized.startsWith("/")) {
					return buildFileUri(normalized);
				}

				if (normalized.startsWith("raw:/")) {
					return buildFileUri(normalized.slice(4));
				}

				if (normalized.startsWith("raw:")) {
					return buildFileUri(normalized.slice(4));
				}

				const separator = normalized.indexOf(":");
				if (separator === -1) return null;

				const root = normalized.slice(0, separator);
				const remainder = normalized.slice(separator + 1);
				if (!remainder) return null;

				switch (root) {
					case "primary":
						return buildFileUri(`/storage/emulated/0/${remainder}`);
					default:
						if (/^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(root)) {
							return buildFileUri(`/storage/${root}/${remainder}`);
						}
				}
				return null;
			default:
				return null;
		}
	} catch (_) {
		return null;
	}
}

function buildFileUri(pathname) {
	if (!pathname) return null;
	const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
	const encoded = encodeURI(normalized).replace(/#/g, "%23");
	return `file://${encoded}`;
}
