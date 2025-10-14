import { getModes } from "cm/modelist";
import toast from "components/toast";
import lspClientManager from "./clientManager";
import serverRegistry from "./serverRegistry";

function getActiveMetadata(manager, file) {
	if (!manager?.getLspMetadata || !file) return null;
	const metadata = manager.getLspMetadata(file);
	if (!metadata) return null;
	metadata.view = manager.editor;
	return metadata;
}

export function registerLspFormatter(acode) {
	const languages = new Set();
	serverRegistry.listServers().forEach((server) => {
		(server.languages || []).forEach((lang) => {
			if (lang) languages.add(String(lang));
		});
	});
	const extensions = languages.size
		? collectFormatterExtensions(languages)
		: ["*"];

	acode.registerFormatter(
		"lsp",
		extensions,
		async () => {
			const manager = window.editorManager;
			const file = manager?.activeFile;
			const metadata = getActiveMetadata(manager, file);
			if (!metadata) {
				toast("LSP formatter unavailable");
				return false;
			}
			const languageId = metadata.languageId;
			if (!languageId) {
				toast("Unknown language for LSP formatting");
				return false;
			}
			const servers = serverRegistry.getServersForLanguage(languageId);
			if (!servers.length) {
				toast("No LSP formatter available");
				return false;
			}
			metadata.languageName = metadata.languageName || languageId;
			const success = await lspClientManager.formatDocument(metadata);
			if (!success) {
				toast("LSP formatter failed");
			}
			return success;
		},
		"Language Server",
	);
}

function collectFormatterExtensions(languages) {
	const extensions = new Set();
	const modeMap = new Map();

	try {
		getModes().forEach((mode) => {
			const key = String(mode?.name || "")
				.trim()
				.toLowerCase();
			if (key) modeMap.set(key, mode);
		});
	} catch (_) {}

	languages.forEach((language) => {
		const key = String(language || "")
			.trim()
			.toLowerCase();
		if (!key) return;
		extensions.add(key);
		const mode = modeMap.get(key);
		if (!mode?.extensions) return;
		String(mode.extensions)
			.split("|")
			.forEach((part) => {
				const ext = part.trim();
				if (ext && !ext.startsWith("^")) {
					extensions.add(ext);
				}
			});
	});

	if (!extensions.size) {
		return ["*"];
	}

	return Array.from(extensions);
}
