import toast from "components/toast";
import confirm from "dialogs/confirm";
import loader from "dialogs/loader";

const managedServers = new Map();
const checkedCommands = new Map();
const announcedServers = new Set();

const STATUS_PRESENT = "present";
const STATUS_DECLINED = "declined";
const STATUS_FAILED = "failed";

const AXS_BINARY = "$PREFIX/axs";

function getExecutor() {
	const executor = globalThis.Executor;
	if (!executor) {
		throw new Error("Executor plugin is not available");
	}
	return executor;
}

function joinCommand(command, args = []) {
	if (!Array.isArray(args)) return command;
	return [command, ...args].join(" ");
}

function wrapShellCommand(command) {
	const script = command.trim();
	const escaped = script.replace(/"/g, '\\"');
	return `sh -lc "set -e; ${escaped}"`;
}

async function runCommand(command) {
	const wrapped = wrapShellCommand(command);
	return getExecutor().execute(wrapped, true);
}

function quoteArg(value) {
	const str = String(value ?? "");
	if (!str.length) return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
	return `'${str.replace(/'/g, "'\\''")}'`;
}

function buildAxsBridgeCommand(bridge) {
	if (!bridge || bridge.kind !== "axs") return null;
	const port = Number(bridge.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(
			`Bridge requires a valid TCP port (received ${bridge.port})`,
		);
	}
	const binary = bridge.command
		? String(bridge.command)
		: (() => {
				throw new Error("Bridge requires a command to execute");
			})();
	const args = Array.isArray(bridge.args)
		? bridge.args.map((arg) => String(arg))
		: [];

	const parts = [AXS_BINARY, "--port", String(port), "lsp", quoteArg(binary)];
	if (args.length) {
		parts.push("--");
		args.forEach((arg) => parts.push(quoteArg(arg)));
	}
	return parts.join(" ");
}

function resolveStartCommand(server) {
	const launcher = server.launcher || {};
	if (launcher.startCommand) {
		return Array.isArray(launcher.startCommand)
			? launcher.startCommand.join(" ")
			: String(launcher.startCommand);
	}
	if (launcher.command) {
		return joinCommand(launcher.command, launcher.args);
	}
	if (launcher.bridge) {
		return buildAxsBridgeCommand(launcher.bridge);
	}
	return null;
}

async function ensureInstalled(server) {
	const launcher = server.launcher;
	if (!launcher?.checkCommand) return true;

	const cacheKey = `${server.id}:${launcher.checkCommand}`;
	if (checkedCommands.has(cacheKey)) {
		return checkedCommands.get(cacheKey) === STATUS_PRESENT;
	}

	try {
		await runCommand(launcher.checkCommand);
		checkedCommands.set(cacheKey, STATUS_PRESENT);
		return true;
	} catch (error) {
		if (!launcher.install) {
			checkedCommands.set(cacheKey, STATUS_FAILED);
			console.warn(
				`LSP server ${server.id} is missing check command result and has no installer.`,
				error,
			);
			throw error;
		}

		const install = launcher.install;
		const displayLabel = (
			server.label ||
			server.id ||
			"Language server"
		).trim();
		const promptMessage = `Install ${displayLabel} language server?`;
		const shouldInstall = await confirm(
			server.label || displayLabel,
			promptMessage,
		);

		if (!shouldInstall) {
			checkedCommands.set(cacheKey, STATUS_DECLINED);
			return false;
		}

		let loadingDialog;
		try {
			loadingDialog = loader.create(
				server.label,
				`Installing ${server.label}...`,
			);
			loadingDialog.show();
			await runCommand(install.command);
			toast(`${server.label} installed`);
			checkedCommands.set(cacheKey, STATUS_PRESENT);
			return true;
		} catch (installError) {
			console.error(`Failed to install ${server.id}`, installError);
			toast(strings?.error || "Error");
			checkedCommands.set(cacheKey, STATUS_FAILED);
			throw installError;
		} finally {
			loadingDialog?.destroy?.();
		}
	}
}

async function startInteractiveServer(command, serverId) {
	const executor = getExecutor();
	const uuid = await executor.start(
		command,
		(type, data) => {
			if (type === "stderr") {
				if (/proot warning/i.test(data)) return;
				console.warn(`[${serverId}] ${data}`);
			} else if (type === "stdout" && data && data.trim()) {
				console.info(`[${serverId}] ${data}`);
			}
		},
		true,
	);
	managedServers.set(serverId, {
		uuid,
		command,
		startedAt: Date.now(),
	});
	return uuid;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWebSocket(
	url,
	{ attempts = 20, delay = 200, probeTimeout = 2000 } = {},
) {
	let lastError = null;
	for (let i = 0; i < attempts; i++) {
		try {
			await new Promise((resolve, reject) => {
				let socket;
				let timer;
				try {
					socket = new WebSocket(url);
				} catch (error) {
					reject(error);
					return;
				}

				const cleanup = (cb) => {
					if (timer) clearTimeout(timer);
					if (socket) {
						socket.onopen = socket.onerror = null;
						try {
							socket.close();
						} catch (_) {}
					}
					cb && cb();
				};

				socket.onopen = () => cleanup(resolve);
				socket.onerror = (event) =>
					cleanup(() =>
						reject(
							event instanceof Error ? event : new Error("websocket error"),
						),
					);
				timer = setTimeout(
					() => cleanup(() => reject(new Error("timeout"))),
					probeTimeout,
				);
			});
			return;
		} catch (error) {
			lastError = error;
			await sleep(delay);
		}
	}
	const reason = lastError
		? lastError.message || lastError.type || String(lastError)
		: "unknown";
	throw new Error(`WebSocket ${url} did not become ready (${reason})`);
}

export async function ensureServerRunning(server) {
	const launcher = server.launcher;
	if (!launcher) return;

	const installed = await ensureInstalled(server);
	if (!installed) {
		const unavailable = new Error(
			`Language server ${server.id} is not available.`,
		);
		unavailable.code = "LSP_SERVER_UNAVAILABLE";
		throw unavailable;
	}

	const key = server.id;
	if (managedServers.has(key)) {
		const existing = managedServers.get(key);
		return existing?.uuid || null;
	}

	const command = await resolveStartCommand(server);
	if (!command) {
		return null;
	}

	try {
		const uuid = await startInteractiveServer(command, key);
		if (
			server.transport?.url &&
			(server.transport.kind === "websocket" ||
				server.transport.kind === "stdio")
		) {
			await waitForWebSocket(server.transport.url);
		}
		if (!announcedServers.has(key)) {
			toast(
				strings?.lsp_connected?.replace("{{label}}", server.label) ||
					`${server.label} connected`,
			);
			announcedServers.add(key);
		}
		return uuid;
	} catch (error) {
		console.error(`Failed to start language server ${server.id}`, error);
		toast(
			`${server.label} failed to connect${error?.message ? `: ${error.message}` : ""}`,
		);
		const entry = managedServers.get(key);
		if (entry) {
			getExecutor()
				.stop(entry.uuid)
				.catch((err) => {
					console.warn(
						`Failed to stop language server shell ${server.id}`,
						err,
					);
				});
			managedServers.delete(key);
		}
		const unavailable = new Error(
			`Language server ${server.id} failed to start (${error?.message || error})`,
		);
		unavailable.code = "LSP_SERVER_UNAVAILABLE";
		throw unavailable;
	}
}

export function stopManagedServer(serverId) {
	const entry = managedServers.get(serverId);
	if (!entry) return;
	getExecutor()
		.stop(entry.uuid)
		.catch((error) => {
			console.warn(`Failed to stop language server ${serverId}`, error);
		});
	managedServers.delete(serverId);
	announcedServers.delete(serverId);
}

export function resetManagedServers() {
	for (const id of Array.from(managedServers.keys())) {
		stopManagedServer(id);
	}
	managedServers.clear();
}
