import { forceLinting, linter, lintGutter } from "@codemirror/lint";
import { LSPPlugin } from "@codemirror/lsp-client";
import { MapMode, StateEffect, StateField } from "@codemirror/state";

const setPublishedDiagnostics = StateEffect.define();

export const LSP_DIAGNOSTICS_EVENT = "acode:lsp-diagnostics-updated";

function emitDiagnosticsUpdated() {
	if (
		typeof document === "undefined" ||
		typeof document.dispatchEvent !== "function"
	) {
		return;
	}

	let event;
	try {
		event = new CustomEvent(LSP_DIAGNOSTICS_EVENT);
	} catch (_) {
		try {
			event = document.createEvent("CustomEvent");
			event.initCustomEvent(LSP_DIAGNOSTICS_EVENT, false, false, undefined);
		} catch (_) {
			return;
		}
	}

	document.dispatchEvent(event);
}

const lspPublishedDiagnostics = StateField.define({
	create() {
		return [];
	},
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setPublishedDiagnostics)) {
				value = effect.value;
			}
		}
		return value;
	},
});

const severities = ["hint", "error", "warning", "info", "hint"];

function storeLspDiagnostics(plugin, diagnostics) {
	const items = [];
	const { syncedDoc } = plugin;

	for (const diagnostic of diagnostics) {
		let from;
		let to;
		try {
			const mappedFrom = plugin.fromPosition(
				diagnostic.range.start,
				plugin.syncedDoc,
			);
			const mappedTo = plugin.fromPosition(
				diagnostic.range.end,
				plugin.syncedDoc,
			);
			from = plugin.unsyncedChanges.mapPos(mappedFrom);
			to = plugin.unsyncedChanges.mapPos(mappedTo);
		} catch (_) {
			continue;
		}
		if (to > syncedDoc.length) continue;

		const severity = severities[diagnostic.severity ?? 0] || "info";
		const source = diagnostic.code
			? `${diagnostic.source ? `${diagnostic.source}-` : ""}${diagnostic.code}`
			: undefined;

		items.push({
			from,
			to,
			severity,
			message: diagnostic.message,
			source,
		});
	}

	return setPublishedDiagnostics.of(items);
}

function mapDiagnostics(plugin, state) {
	plugin.client.sync();
	const stored = state.field(lspPublishedDiagnostics);
	const changes = plugin.unsyncedChanges;
	const mapped = [];

	for (const diagnostic of stored) {
		let from;
		let to;
		try {
			from = changes.mapPos(diagnostic.from, 1, MapMode.TrackDel);
			to = changes.mapPos(diagnostic.to, -1, MapMode.TrackDel);
		} catch (_) {
			continue;
		}
		if (from != null && to != null) {
			mapped.push({ ...diagnostic, from, to });
		}
	}

	return mapped;
}

function lspLinterSource(view) {
	const plugin = LSPPlugin.get(view);
	if (!plugin) return [];
	return mapDiagnostics(plugin, view.state);
}

export function lspDiagnosticsClientExtension() {
	return {
		clientCapabilities: {
			textDocument: {
				publishDiagnostics: {
					relatedInformation: true,
					codeDescriptionSupport: true,
					dataSupport: true,
					versionSupport: true,
				},
			},
		},
		notificationHandlers: {
			"textDocument/publishDiagnostics": (client, params) => {
				const file = client.workspace.getFile(params.uri);
				if (
					!file ||
					(params.version != null && params.version !== file.version)
				) {
					return false;
				}
				const view = file.getView();
				if (!view) return false;
				const plugin = LSPPlugin.get(view);
				if (!plugin) return false;

				view.dispatch({
					effects: storeLspDiagnostics(plugin, params.diagnostics),
				});
				forceLinting(view);
				emitDiagnosticsUpdated();
				return true;
			},
		},
	};
}

export function lspDiagnosticsUiExtension(includeGutter = true) {
	const extensions = [
		lspPublishedDiagnostics,
		linter(lspLinterSource, {
			needsRefresh(update) {
				return update.transactions.some((tr) =>
					tr.effects.some((effect) => effect.is(setPublishedDiagnostics)),
				);
			},
			// keep panel closed by default
			autoPanel: false,
		}),
	];
	if (includeGutter) {
		extensions.splice(1, 0, lintGutter());
	}
	return extensions;
}

export function lspDiagnosticsExtension(includeGutter = true) {
	return {
		...lspDiagnosticsClientExtension(),
		editorExtension: lspDiagnosticsUiExtension(includeGutter),
	};
}

export default lspDiagnosticsExtension;

export function clearDiagnosticsEffect() {
	return setPublishedDiagnostics.of([]);
}

export function getLspDiagnostics(state) {
	if (!state || typeof state.field !== "function") return [];
	try {
		const stored = state.field(lspPublishedDiagnostics, false);
		if (!stored || !Array.isArray(stored)) return [];
		return stored.map((diagnostic) => ({ ...diagnostic }));
	} catch (_) {
		return [];
	}
}
