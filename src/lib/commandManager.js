

// commandManager.js
import {EditorView, keymap} from "@codemirror/view";
import fsOperation from "fileSystem";
import {StateEffect} from "@codemirror/state";
import {defaultKeymap} from "@codemirror/commands";
import Url from "../utils/Url";
import keyBindings from "./keyBindings";

export default class CommandManager {
	constructor(view) {
		this.view = view;
		this.commands = {}; // name → command function
		this.addedKeybindings = new Map(); // name → keybinding object
		this.addedExtensions = new Map(); // name → extension for cleanup

		this.defaultKeymapExtension = keymap.of(defaultKeymap);

		// Macro system
		this.macros = {};
		this.isRecording = false;
		this.currentMacro = [];
		this.currentMacroName = null;

		// ⭐ Hooks (like Ace)
		this._onBeforeExec = [];
		this._onAfterExec = [];
	}


	loadKeybindingsFromConfig(config) {
		// Reset if needed (you can add "reset: true" to your JSON if desired)
		// if (config.reset) this.resetKeybindings();

		for (let [commandName, def] of Object.entries(config)) {
			const {
				key,
				description,
				readOnly = false,
				editorOnly = false,
				action = commandName // fallback to commandName
			} = def;

			if (!key) continue;

			// Split multiple keys: "Ctrl+0|Ctrl-Numpad0" → ["Ctrl+0", "Ctrl-Numpad0"]
			const keyCombos = key.split("|");

			keyCombos.forEach(rawKey => {
				const bindingName = `${commandName}-${rawKey}`;

				this.addCommand({
					name: bindingName,
					bindKey: rawKey,
					exec: (view, args) => {
						// If custom action is provided, try to exec it
						// Otherwise, exec commandName
						const targetCommand = action || commandName;
						return this.exec(targetCommand, view, args);
					},
					readOnly,
					description,
					editorOnly
				});
			});
		}

		console.log(`✅ Loaded ${Object.keys(config).length} command definitions with ${this.addedKeybindings.size} keybindings.`);
	}

	normalizeAceKey(aceKey) {
		// First, replace Ace-style "+" with "-"
		let key = aceKey.replace(/\+/g, "-");

		// Normalize modifiers and special keys
		key = key
			.replace(/Cmd/g, "Mod")
			.replace(/Ctrl/g, "Ctrl")
			.replace(/Shift/g, "Shift")
			.replace(/Alt/g, "Alt")
			.replace(/Enter/g, "Enter")
			.replace(/Return/g, "Enter")
			.replace(/Tab/g, "Tab")
			.replace(/Delete/g, "Delete")
			.replace(/Backspace/g, "Backspace")
			.replace(/Esc/g, "Escape")
			.replace(/Space/g, " ")
			.replace(/Numpad(\d)/g, "Numpad$1") // Keep Numpad0, Numpad1, etc.
			.toLowerCase();

		// Re-capitalize first letter after modifiers for CM6
		key = key
			.replace(/mod-shift-(.)/, (m, c) => `Mod-Shift-${c.toUpperCase()}`)
			.replace(/mod-(.)/, (m, c) => `Mod-${c.toUpperCase()}`)
			.replace(/ctrl-shift-(.)/, (m, c) => `Ctrl-Shift-${c.toUpperCase()}`)
			.replace(/ctrl-(.)/, (m, c) => `Ctrl-${c.toUpperCase()}`)
			.replace(/shift-(.)/, (m, c) => `Shift-${c.toUpperCase()}`)
			.replace(/alt-(.)/, (m, c) => `Alt-${c.toUpperCase()}`);

		return key;
	}

	async loadKeybindingsFromFile(file) {
		try {
			// First, reset to CM6 defaults
			await this.resetKeybindings();

			const bindingsFile = fsOperation(file);
			if (await bindingsFile.exists()) {
				const config = await bindingsFile.readFile("json");

				// Then apply user keybindings on top
				this.loadKeybindingsFromConfig(config);
				console.log("📁 Keybindings loaded from file:", file.name);
			}
		} catch (err) {
			console.warn("⚠️ Failed to load keybindings file, falling back to CodeMirror 6 defaults:", err);

			// Fallback: reset to defaults
			await this.resetKeybindings();
		}
	}

	_defaultKeybindingsConfig = {
		focusEditor: {
			key: "Ctrl-1",
			description: "Focus Editor",
			readOnly: false
		},
		resetFontSize: {
			key: "Ctrl-0|Ctrl-Numpad0",
			description: "Reset Font Size",
			editorOnly: true
		},
		openTerminal: {
			key: "Ctrl-`",
			description: "Open terminal",
			readOnly: true,
			action: "open-terminal"
		}
		// Add more defaults here
	};

	async resetKeybindings() {
		try {
			// Clear all our dynamic keymap extensions
			this.addedExtensions.clear();
			this.addedKeybindings.clear();

			const fs = fsOperation(KEYBINDING_FILE);
			const fileName = Url.basename(KEYBINDING_FILE);
			const defaultKeymapJSON = defaultKeymap.reduce((acc, c) => {
				acc[c.key] = c;
				return acc
			}, {})
			const content = JSON.stringify(defaultKeymapJSON, undefined, 2);

			if (!(await fs.exists())) {
				await fsOperation(DATA_STORAGE).createFile(fileName, content);
				return;
			}

			await fs.writeFile(content);

			// Reconfigure with ONLY CodeMirror 6 defaults
			this.view.dispatch({
				// TODO: reset to CodeMirror 6 defaults Along with Acode App-based Default keymaps
				effects: StateEffect.reconfigure.of([this.defaultKeymapExtension])
			});

			// Re-add defaults
			// this.loadKeybindingsFromConfig(this._defaultKeybindingsConfig);

			console.log("🔄 Keybindings reset to defaults");
		} catch (err) {
			console.log("⚠️ Failed to reset keybindings err: ", err)
		}
	}

	exportKeybindings() {
		const config = {};

		for (let [bindingName, bindingDef] of this.addedKeybindings.entries()) {
			// Extract original command name (before "-key" suffix)
			const match = bindingName.match(/^(.+?)-[^-]+$/);
			const commandName = match ? match[1] : bindingName;

			// Get full command def (if available)
			const cmd = this.commands[bindingName];

			if (!config[commandName]) {
				config[commandName] = {
					key: [],
					description: cmd?.description || "",
					readOnly: cmd?.readOnly || false,
					editorOnly: cmd?.editorOnly || false,
					action: cmd?.action || (commandName === bindingName ? undefined : commandName)
				};
			}

			// Add this key combo
			config[commandName].key.push(bindingDef.key || bindingDef.mac || "");
		}

		// Join keys with "|"
		for (let def of Object.values(config)) {
			def.key = def.key.join("|");
		}

		return JSON.stringify(config, null, 2);
	}

	// ➕ Add command (like Ace)
	addCommand(commandDef) {
		// Support both `exec` and `run` (Ace uses both)
		const { name, exec, run, bindKey, readOnly = false, ...rest } = commandDef;
		const handler = exec || run; // Prefer exec, fallback to run

		if (!name || typeof handler !== "function") {
			console.warn(`Command must have 'name' and 'exec' or 'run' function`);
			return;
		}

		// ⚠️ Warn if handler doesn't seem to accept parameters (we pass 3 args)
		// Check function length (number of declared parameters)
		if (handler.length === 0) {
			console.warn(`Command '${name}' has handler with 0 parameters. Expected at least (view, args, commandManager). Consider adding parameters for full functionality.`);
		}

		// Wrap handler with hook + readOnly support
		const wrappedExec = (view, args = {}) => {
			if (readOnly && !view.state.readOnly) {
				console.warn(`Command '${name}' is read-only but editor is not.`);
				return false;
			}

			// 🔔 Trigger beforeExec hooks
			for (let hook of this._onBeforeExec) {
				const result = hook({ command: name, args, view });
				if (result === false) return false; // Cancel execution
			}

			// Execute command — always pass view, args, this (commandManager)
			const result = handler(view, args, this);

			// 🔔 Trigger afterExec hooks
			for (let hook of this._onAfterExec) {
				hook({ command: name, args, view, result });
			}

			// Record if macro recording
			if (this.isRecording) {
				this.currentMacro.push({ command: name, args });
			}

			return result;
		};

		this.commands[name] = wrappedExec;

		// Register keybinding if provided
		if (bindKey) {
			const keyBinding = this.normalizeBindKey(bindKey, name);
			const ext = keymap.of([keyBinding]);
			this.view.dispatch({
				effects: StateEffect.appendConfig.of(ext)
			});
			this.addedKeybindings.set(name, keyBinding);
			this.addedExtensions.set(name, ext);
		}

		console.log(`➕ Command added: ${name}`);
	}

	normalizeBindKey(bindKey, commandName) {
		if (typeof bindKey === "string") {
			return {
				key: bindKey,
				run: (view) => this.exec(commandName, view)
			};
		} else {
			return {
				key: bindKey.win || bindKey.pc || bindKey.linux || "",
				mac: bindKey.mac || "",
				run: (view) => this.exec(commandName, view)
			};
		}
	}

	// ➖ Remove command (like Ace)
	removeCommand(name) {
		delete this.commands[name];

		if (this.addedExtensions.has(name)) {
			const extToRemove = this.addedExtensions.get(name);

			// Get current dynamic extensions (excluding this one)
			const remainingExtensions = [...this.addedExtensions.entries()]
				.filter(([key]) => key !== name)
				.map(([, ext]) => ext);

			// Reconfigure with remaining dynamic extensions
			this.view.dispatch({
				effects: StateEffect.reconfigure.of(remainingExtensions)
			});

			this.addedExtensions.delete(name);
			this.addedKeybindings.delete(name);

			console.log(`🗑️ Command and keybinding removed: ${name}`);
		}
	}

	// ▶️ Execute command by name
	exec(name, view = this.view, args = {}) {
		const cmd = this.commands[name];
		if (!cmd) {
			console.warn(`⚠️ Command not found: ${name}`);
			return false;
		}
		return cmd(view, args);
	}

	// 🎥 Macro System
	startRecording(name = "default") {
		this.isRecording = true;
		this.currentMacro = [];
		this.currentMacroName = name;
		console.log(`📹 Recording macro: ${name}`);
	}

	stopRecording() {
		if (!this.isRecording) return;
		this.macros[this.currentMacroName] = [...this.currentMacro];
		this.isRecording = false;
		console.log(`✅ Macro "${this.currentMacroName}" recorded (${this.currentMacro.length} steps)`);
	}

	replayMacro(name = "default") {
		const steps = this.macros[name];
		if (!steps) {
			console.warn(`Macro "${name}" not found.`);
			return false;
		}

		console.log(`▶️ Replaying macro: ${name}`);
		let success = true;

		for (let step of steps) {
			const { command, args = {} } = step;
			const result = this.exec(command, this.view, args);
			if (!result) success = false;
		}

		return success;
	}

	// 🎣 Hook System (like Ace's .on("beforeExec", ...) )
	on(event, handler) {
		if (event === "beforeExec") {
			this._onBeforeExec.push(handler);
		} else if (event === "afterExec") {
			this._onAfterExec.push(handler);
		} else {
			console.warn(`Unknown event: ${event}`);
		}
	}

	off(event, handler) {
		if (event === "beforeExec") {
			this._onBeforeExec = this._onBeforeExec.filter(h => h !== handler);
		} else if (event === "afterExec") {
			this._onAfterExec = this._onAfterExec.filter(h => h !== handler);
		}
	}

	// Optional: Clear all hooks
	clearAllHooks() {
		this._onBeforeExec = [];
		this._onAfterExec = [];
	}
}
