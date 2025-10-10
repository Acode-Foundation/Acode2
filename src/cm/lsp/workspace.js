import { LSPPlugin, Workspace } from "@codemirror/lsp-client";

class AcodeWorkspaceFile {
	constructor(uri, languageId, version, doc, view) {
		this.uri = uri;
		this.languageId = languageId;
		this.version = version;
		this.doc = doc;
		this.views = new Set();
		if (view) this.views.add(view);
	}

	getView(preferred) {
		if (preferred && this.views.has(preferred)) return preferred;
		const iterator = this.views.values();
		const next = iterator.next();
		return next.done ? null : next.value;
	}
}

export default class AcodeWorkspace extends Workspace {
	constructor(client, options = {}) {
		super(client);
		this.files = [];
		this.#fileMap = new Map();
		this.#versions = Object.create(null);
		this.options = options;
	}

	#fileMap;
	#versions;

	#getOrCreateFile(uri, languageId, view) {
		let file = this.#fileMap.get(uri);
		if (!file) {
			file = new AcodeWorkspaceFile(
				uri,
				languageId,
				this.#nextFileVersion(uri),
				view.state?.doc,
				view,
			);
			this.#fileMap.set(uri, file);
			this.files.push(file);
			this.client.didOpen(file);
		}
		file.views.add(view);
		return file;
	}

	#getFileEntry(uri) {
		return this.#fileMap.get(uri) || null;
	}

	#removeFileEntry(file) {
		this.#fileMap.delete(file.uri);
		this.files = this.files.filter((candidate) => candidate !== file);
	}

	#nextFileVersion(uri) {
		const current = this.#versions[uri] ?? -1;
		const next = current + 1;
		this.#versions[uri] = next;
		return next;
	}

	syncFiles() {
		const updates = [];
		for (const file of this.files) {
			const view = file.getView();
			if (!view) continue;
			const plugin = LSPPlugin.get(view);
			if (!plugin) continue;
			const { unsyncedChanges } = plugin;
			if (unsyncedChanges.empty) continue;

			updates.push({ file, prevDoc: file.doc, changes: unsyncedChanges });
			file.doc = view.state.doc;
			file.version = this.#nextFileVersion(file.uri);
			plugin.clear();
		}
		return updates;
	}

	openFile(uri, languageId, view) {
		if (!view) return;
		this.#getOrCreateFile(uri, languageId, view);
	}

	closeFile(uri, view) {
		const file = this.#getFileEntry(uri);
		if (!file) return;

		if (view && file.views.has(view)) {
			file.views.delete(view);
		}

		if (!file.views.size) {
			this.client.didClose(uri);
			this.#removeFileEntry(file);
		}
	}

	getFile(uri) {
		return this.#getFileEntry(uri);
	}

	async displayFile(uri) {
		if (typeof this.options.displayFile === "function") {
			try {
				return await this.options.displayFile(uri);
			} catch (error) {
				console.error("Failed to display file via workspace", error);
			}
		}
		return null;
	}
}
