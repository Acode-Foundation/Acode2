import serverRegistry from "cm/lsp/serverRegistry";
import settingsPage from "components/settingsPage";
import appSettings from "lib/settings";

function getServerOverride(id) {
	return appSettings.value?.lsp?.servers?.[id] || {};
}

export default function lspSettings() {
	const title = strings?.lsp_settings || "Language Servers";
	const servers = serverRegistry.listServers();

	const items = [];

	for (const server of servers) {
		const override = getServerOverride(server.id);
		const serverEnabled = override.enabled ?? server.enabled;
		const infoParts = [];
		if (Array.isArray(server.languages) && server.languages.length) {
			infoParts.push(server.languages.join(", "));
		}
		items.push({
			key: `server:${server.id}`,
			text: server.label,
			checkbox: serverEnabled,
			info: infoParts.join(" · ") || undefined,
		});
	}

	return settingsPage(title, items, callback);

	async function callback(key, value) {
		if (key.startsWith("server:")) {
			const id = key.split(":")[1];
			const override = {
				...(appSettings.value.lsp?.servers?.[id] || {}),
				enabled: !!value,
			};
			await updateConfig({ servers: { [id]: override } });
		}
	}

	async function updateConfig(partial) {
		const current = JSON.parse(JSON.stringify(appSettings.value.lsp || {}));
		if (partial.servers) {
			current.servers = {
				...(current.servers || {}),
				...partial.servers,
			};
		}

		await appSettings.update(
			{
				lsp: current,
			},
			false,
		);
	}
}
