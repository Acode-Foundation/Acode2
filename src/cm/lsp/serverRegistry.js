/**
 * @typedef {Object} LspTransportDescriptor
 * @property {"stdio"|"websocket"|"external"} kind
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {Record<string, any>} [options]
 * @property {string} [url]
 */

/**
 * @typedef {Object} LspServerDefinition
 * @property {string} id
 * @property {string} label
 * @property {boolean} [enabled]
 * @property {string[]} languages
 * @property {LspTransportDescriptor} transport
 * @property {Record<string, any>} [initializationOptions]
 * @property {Record<string, any>} [clientConfig]
 * @property {number} [startupTimeout]
 * @property {Record<string, any>} [capabilityOverrides]
 * @property {(uri: string, context: any) => string | null} [rootUri]
 * @property {(metadata: any) => string | null} [resolveLanguageId]
 */

const registry = new Map();
const listeners = new Set();

function toKey(id) {
	return String(id || "")
		.trim()
		.toLowerCase();
}

function clone(value) {
	if (!value || typeof value !== "object") return undefined;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch (_) {
		return value;
	}
}

function sanitizeLanguages(languages = []) {
	if (!Array.isArray(languages)) return [];
	return languages
		.map((lang) =>
			String(lang || "")
				.trim()
				.toLowerCase(),
		)
		.filter(Boolean);
}

function parsePort(value) {
	const num = Number(value);
	if (!Number.isFinite(num)) return null;
	const int = Math.floor(num);
	if (int !== num || int <= 0 || int > 65535) return null;
	return int;
}

function sanitizeBridge(serverId, bridge) {
	if (!bridge || typeof bridge !== "object") return undefined;
	const kind = bridge.kind || "axs";
	if (kind !== "axs") {
		throw new Error(
			`LSP server ${serverId} declares unsupported bridge kind ${kind}`,
		);
	}
	const port = parsePort(bridge.port);
	if (!port) {
		throw new Error(`LSP server ${serverId} bridge requires a valid port`);
	}
	const command = bridge.command ? String(bridge.command) : null;
	if (!command) {
		throw new Error(`LSP server ${serverId} bridge must supply a command`);
	}
	const args = Array.isArray(bridge.args)
		? bridge.args.map((arg) => String(arg))
		: undefined;
	return {
		kind,
		port,
		command,
		args,
	};
}

function sanitizeDefinition(definition) {
	if (!definition || typeof definition !== "object") {
		throw new TypeError("LSP server definition must be an object");
	}

	const id = toKey(definition.id);
	if (!id) throw new Error("LSP server definition requires a non-empty id");

	const transport = definition.transport || {};
	const kind = transport.kind || "stdio";

	if (!transport || typeof transport !== "object") {
		throw new Error(`LSP server ${id} is missing a transport descriptor`);
	}

	if (
		!("languages" in definition) ||
		!sanitizeLanguages(definition.languages).length
	) {
		throw new Error(`LSP server ${id} must declare supported languages`);
	}

	if (kind === "stdio" && !transport.command) {
		throw new Error(`LSP server ${id} (stdio) requires a command`);
	}

	if (kind === "websocket" && !transport.url) {
		throw new Error(`LSP server ${id} (websocket) requires a url`);
	}

	const transportOptions =
		transport.options && typeof transport.options === "object"
			? { ...transport.options }
			: {};

	const sanitized = {
		id,
		label: definition.label || id,
		enabled: definition.enabled !== false,
		languages: sanitizeLanguages(definition.languages),
		transport: {
			kind,
			command: transport.command,
			args: Array.isArray(transport.args)
				? transport.args.map((arg) => String(arg))
				: undefined,
			options: transportOptions,
			url: transport.url,
			protocols: undefined,
		},
		initializationOptions: clone(definition.initializationOptions),
		clientConfig: clone(definition.clientConfig),
		startupTimeout:
			typeof definition.startupTimeout === "number"
				? definition.startupTimeout
				: undefined,
		capabilityOverrides: clone(definition.capabilityOverrides),
		rootUri:
			typeof definition.rootUri === "function" ? definition.rootUri : null,
		resolveLanguageId:
			typeof definition.resolveLanguageId === "function"
				? definition.resolveLanguageId
				: null,
		launcher:
			definition.launcher && typeof definition.launcher === "object"
				? {
						command: definition.launcher.command,
						args: Array.isArray(definition.launcher.args)
							? definition.launcher.args.map((arg) => String(arg))
							: undefined,
						startCommand: Array.isArray(definition.launcher.startCommand)
							? definition.launcher.startCommand.map((arg) => String(arg))
							: definition.launcher.startCommand,
						checkCommand: definition.launcher.checkCommand,
						install:
							definition.launcher.install &&
							typeof definition.launcher.install === "object"
								? {
										command: definition.launcher.install.command,
									}
								: undefined,
						bridge: sanitizeBridge(id, definition.launcher.bridge),
					}
				: undefined,
	};

	if (!Object.keys(transportOptions).length) {
		sanitized.transport.options = undefined;
	}

	return sanitized;
}

function resolveJsTsLanguageId(languageId, languageName) {
	const lang = toKey(languageId || languageName);
	switch (lang) {
		case "tsx":
		case "typescriptreact":
			return "typescriptreact";
		case "jsx":
		case "javascriptreact":
			return "javascriptreact";
		case "ts":
			return "typescript";
		case "js":
			return "javascript";
		default:
			return lang || null;
	}
}

function notify(event, payload) {
	listeners.forEach((fn) => {
		try {
			fn(event, payload);
		} catch (error) {
			console.error("LSP server registry listener failed", error);
		}
	});
}

export function registerServer(definition, { replace = false } = {}) {
	const normalized = sanitizeDefinition(definition);
	const exists = registry.has(normalized.id);
	if (exists && !replace) return registry.get(normalized.id);

	registry.set(normalized.id, normalized);
	notify("register", normalized);
	return normalized;
}

export function unregisterServer(id) {
	const key = toKey(id);
	if (!key || !registry.has(key)) return false;
	const existing = registry.get(key);
	registry.delete(key);
	notify("unregister", existing);
	return true;
}

export function updateServer(id, updater) {
	const key = toKey(id);
	if (!key || !registry.has(key)) return null;
	const current = registry.get(key);
	const next = updater({ ...current });
	if (!next) return current;
	const normalized = sanitizeDefinition({
		...current,
		...next,
		id: current.id,
	});
	registry.set(key, normalized);
	notify("update", normalized);
	return normalized;
}

export function getServer(id) {
	return registry.get(toKey(id)) || null;
}

export function listServers() {
	return Array.from(registry.values());
}

export function getServersForLanguage(
	languageId,
	{ includeDisabled = false } = {},
) {
	const langKey = toKey(languageId);
	if (!langKey) return [];

	return listServers().filter((server) => {
		if (!includeDisabled && !server.enabled) return false;
		return server.languages.includes(langKey);
	});
}

export function onRegistryChange(listener) {
	if (typeof listener !== "function") return () => {};
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function registerBuiltinServers() {
	const defaults = [
		{
			id: "typescript",
			label: "TypeScript / JavaScript",
			languages: [
				"javascript",
				"javascriptreact",
				"typescript",
				"typescriptreact",
				"tsx",
				"jsx",
			],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2090",
			},
			launcher: {
				bridge: {
					kind: "axs",
					port: 2090,
					command: "typescript-language-server",
					args: ["--stdio"],
				},
				checkCommand: "which typescript-language-server",
				install: {
					command:
						"apk add --no-cache nodejs npm && npm install -g typescript-language-server typescript",
				},
			},
			enabled: false,
			resolveLanguageId: ({ languageId, languageName }) =>
				resolveJsTsLanguageId(languageId, languageName),
		},
		{
			id: "vtsls",
			label: "TypeScript / JavaScript (vtsls)",
			languages: [
				"javascript",
				"javascriptreact",
				"typescript",
				"typescriptreact",
				"tsx",
				"jsx",
			],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2095",
			},
			launcher: {
				bridge: {
					kind: "axs",
					port: 2095,
					command: "vtsls",
					args: ["--stdio"],
				},
				checkCommand: "which vtsls",
				install: {
					command:
						"apk add --no-cache nodejs npm && npm install -g @vtsls/language-server",
				},
			},
			enabled: false,
			resolveLanguageId: ({ languageId, languageName }) =>
				resolveJsTsLanguageId(languageId, languageName),
		},
		{
			id: "python",
			label: "Python (pylsp)",
			languages: ["python"],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2087",
			},
			launcher: {
				command: "pylsp",
				args: ["--ws", "--host", "127.0.0.1", "--port", "2087"],
				checkCommand: "which pylsp",
				install: {
					command:
						"apk update && apk upgrade && apk add python3 py3-pip && PIP_BREAK_SYSTEM_PACKAGES=1 pip install 'python-lsp-server[websockets,all]'",
				},
			},
			initializationOptions: {
				pylsp: {
					plugins: {
						pyflakes: { enabled: true },
						pycodestyle: { enabled: true },
						mccabe: { enabled: true },
					},
				},
			},
			enabled: false,
		},
		{
			id: "eslint",
			label: "ESLint",
			languages: [
				"javascript",
				"javascriptreact",
				"typescript",
				"typescriptreact",
				"tsx",
				"jsx",
			],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2096",
			},
			launcher: {
				bridge: {
					kind: "axs",
					port: 2096,
					command: "vscode-eslint-language-server",
					args: ["--stdio"],
				},
				checkCommand: "which vscode-eslint-language-server",
				install: {
					command:
						"apk add --no-cache nodejs npm && npm install -g vscode-langservers-extracted",
				},
			},
			enabled: false,
			clientConfig: {
				builtinExtensions: {
					hover: false,
					completion: false,
					signature: false,
					keymaps: false,
				},
			},
			resolveLanguageId: ({ languageId, languageName }) =>
				resolveJsTsLanguageId(languageId, languageName),
		},
		{
			id: "clangd",
			label: "C / C++ (clangd)",
			languages: ["c", "cpp"],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2094",
			},
			launcher: {
				bridge: {
					kind: "axs",
					port: 2094,
					command: "clangd",
				},
				checkCommand: "which clangd",
				install: {
					command: "apk add --no-cache clang-extra-tools",
				},
			},
			enabled: false,
		},
		{
			id: "html",
			label: "HTML",
			languages: ["html", "vue", "svelte"],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2091",
			},
			launcher: {
				bridge: {
					kind: "axs",
					port: 2091,
					command: "vscode-html-language-server",
					args: ["--stdio"],
				},
				checkCommand: "which vscode-html-language-server",
				install: {
					command:
						"apk add --no-cache nodejs npm && npm install -g vscode-langservers-extracted",
				},
			},
			enabled: false,
		},
		{
			id: "css",
			label: "CSS",
			languages: ["css", "scss", "less"],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2092",
			},
			launcher: {
				bridge: {
					kind: "axs",
					port: 2092,
					command: "vscode-css-language-server",
					args: ["--stdio"],
				},
				checkCommand: "which vscode-css-language-server",
				install: {
					command:
						"apk add --no-cache nodejs npm && npm install -g vscode-langservers-extracted",
				},
			},
			enabled: false,
		},
		{
			id: "json",
			label: "JSON",
			languages: ["json", "jsonc"],
			transport: {
				kind: "websocket",
				url: "ws://127.0.0.1:2093",
			},
			launcher: {
				bridge: {
					kind: "axs",
					port: 2093,
					command: "vscode-json-language-server",
					args: ["--stdio"],
				},
				checkCommand: "which vscode-json-language-server",
				install: {
					command:
						"apk add --no-cache nodejs npm && npm install -g vscode-langservers-extracted",
				},
			},
			enabled: false,
		},
	];

	defaults.forEach((def) => {
		try {
			registerServer(def, { replace: false });
		} catch (error) {
			console.error("Failed to register builtin LSP server", def.id, error);
		}
	});
}

registerBuiltinServers();

export default {
	registerServer,
	unregisterServer,
	updateServer,
	getServer,
	getServersForLanguage,
	listServers,
	onRegistryChange,
};
