import sidebarApps from "sidebarApps";

import {
	setKeyBindings as applyKeyBindings,
	executeCommand,
	getCommandKeymapExtension,
	getRegisteredCommands,
	refreshCommandKeymap,
	registerExternalCommand,
	removeExternalCommand,
} from "../codemirror/commandRegistry";
// TODO: Migrate touch handlers to CodeMirror
// import touchListeners, { scrollAnimationFrame } from "ace/touchHandler";

import { indentUnit } from "@codemirror/language";
import { search } from "@codemirror/search";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
	EditorView,
	highlightActiveLineGutter,
	highlightTrailingWhitespace,
	highlightWhitespace,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import {
	abbreviationTracker,
	emmetConfig,
	expandAbbreviation,
	wrapWithAbbreviation,
} from "@emmetio/codemirror6-plugin";
import createBaseExtensions from "../codemirror/baseExtensions";
// CodeMirror mode management
import {
	getModeForPath,
	getModes,
	getModesByName,
	initModes,
} from "../codemirror/modelist";
import "../codemirror/supportedModes";
import { autocompletion } from "@codemirror/autocomplete";
import list from "components/collapsableList";
import quickTools from "components/quickTools";
import ScrollBar from "components/scrollbar";
import SideButton, { sideButtonContainer } from "components/sideButton";
import keyboardHandler, { keydownState } from "handlers/keyboard";
import actions from "handlers/quickTools";
import colorView from "../codemirror/colorView";
import {
	getAllFolds,
	restoreFolds,
	restoreSelection,
	setScrollPosition,
} from "../codemirror/editorUtils";
import rainbowBrackets from "../codemirror/rainbowBrackets";
import themeRegistry, { getThemeById, getThemes } from "../codemirror/themes";
// TODO: Update EditorFile for CodeMirror compatibility
import EditorFile from "./editorFile";
import appSettings from "./settings";
import {
	getSystemConfiguration,
	HARDKEYBOARDHIDDEN_NO,
} from "./systemConfiguration";

/**
 * Represents an editor manager that handles multiple files and provides various editor configurations and event listeners.
 * @param {HTMLElement} $header - The header element.
 * @param {HTMLElement} $body - The body element.
 * @returns {Promise<Object>} A promise that resolves to the editor manager object.
 */
async function EditorManager($header, $body) {
	/**
	 * @type {Collapsible & HTMLElement}
	 */
	let $openFileList;
	let TIMEOUT_VALUE = 500;
	let preventScrollbarV = false;
	let preventScrollbarH = false;
	let scrollBarVisibilityCount = 0;
	let timeoutQuicktoolsToggler;
	let timeoutHeaderToggler;
	let isScrolling = false;
	let lastScrollTop = 0;
	let lastScrollLeft = 0;

	// Debounce timers for CodeMirror change handling
	let checkTimeout = null;
	let autosaveTimeout = null;

	const { scrollbarSize } = appSettings.value;
	const events = {
		"switch-file": [],
		"rename-file": [],
		"save-file": [],
		"file-loaded": [],
		"file-content-changed": [],
		"add-folder": [],
		"remove-folder": [],
		update: [],
		"new-file": [],
		"remove-file": [],
		"int-open-file-list": [],
		emit(event, ...args) {
			if (!events[event]) return;
			events[event].forEach((fn) => fn(...args));
		},
	};
	const $container = <div className="editor-container"></div>;
	// Ensure the container participates well in flex layouts and can constrain the editor
	$container.style.flex = "1 1 auto";
	$container.style.minHeight = "0"; // allow child scroller to size correctly
	$container.style.height = "100%";
	$container.style.width = "100%";
	const problemButton = SideButton({
		text: strings.problems,
		icon: "warningreport_problem",
		backgroundColor: "var(--danger-color)",
		textColor: "var(--danger-text-color)",
		onclick() {
			acode.exec("open", "problems");
		},
	});

	// Make CodeMirror fill the container height and manage scrolling internally
	const fixedHeightTheme = EditorView.theme({
		"&": { height: "100%" },
		".cm-scroller": { height: "100%", overflow: "auto" },
	});

	// Compartment to swap editor theme dynamically
	const themeCompartment = new Compartment();
	// Compartments to control indentation, tab width, and font styling dynamically
	const indentUnitCompartment = new Compartment();
	const tabSizeCompartment = new Compartment();
	const fontStyleCompartment = new Compartment();
	// Compartment for line wrapping
	const wrapCompartment = new Compartment();
	// Compartment for line numbers
	const lineNumberCompartment = new Compartment();
	// Compartment for text direction (RTL/LTR)
	const rtlCompartment = new Compartment();
	// Compartment for whitespace visualization
	const whitespaceCompartment = new Compartment();
	// Compartment for fold gutter theme (fade)
	const foldThemeCompartment = new Compartment();
	// Compartment for autocompletion behavior
	const completionCompartment = new Compartment();
	// Compartment for rainbow bracket colorizer
	const rainbowCompartment = new Compartment();
	// Compartment for read-only toggling
	const readOnlyCompartment = new Compartment();
	// Compartment for language mode (allows async loading/reconfigure)
	const languageCompartment = new Compartment();

	function getEditorFontFamily() {
		const font = appSettings?.value?.editorFont || "Roboto Mono";
		return `${font}, Noto Mono, Monaco, monospace`;
	}

	function makeFontTheme() {
		const fontSize = appSettings?.value?.fontSize || "12px";
		const lineHeight = appSettings?.value?.lineHeight || 1.6;
		return EditorView.theme({
			"&": { fontSize, lineHeight: String(lineHeight) },
			".cm-content": { fontFamily: getEditorFontFamily() },
			".cm-tooltip": { fontFamily: getEditorFontFamily() },
		});
	}

	function makeWrapExtension() {
		return appSettings?.value?.textWrap ? EditorView.lineWrapping : [];
	}

	function makeLineNumberExtension() {
		const { linenumbers = true, relativeLineNumbers = false } =
			appSettings?.value || {};
		if (!linenumbers)
			return EditorView.theme({
				".cm-gutter": {
					display: "none !important",
					width: "0px !important",
					minWidth: "0px !important",
					border: "none !important",
				},
			});
		if (!relativeLineNumbers)
			return [lineNumbers(), highlightActiveLineGutter()];
		return [
			lineNumbers({
				formatNumber: (lineNo, state) => {
					try {
						const cur = state.doc.lineAt(state.selection.main.head).number;
						const diff = Math.abs(lineNo - cur);
						return diff === 0 ? String(lineNo) : String(diff);
					} catch (_) {
						return String(lineNo);
					}
				},
			}),
			highlightActiveLineGutter(),
		];
	}

	function makeIndentExtensions() {
		const { softTab = true, tabSize = 2 } = appSettings?.value || {};
		const unit = softTab ? " ".repeat(Math.max(1, Number(tabSize) || 2)) : "\t";
		return {
			indentExt: indentUnit.of(unit),
			tabSizeExt: EditorState.tabSize.of(Math.max(1, Number(tabSize) || 2)),
		};
	}

	// Centralised CodeMirror options registry for organized configuration
	// Each spec declares related settings keys, its compartment(s), and a builder returning extension(s)
	const cmOptionSpecs = [
		{
			keys: ["rainbowBrackets"],
			compartments: [rainbowCompartment],
			build() {
				const enabled = appSettings?.value?.rainbowBrackets ?? true;
				if (!enabled) return [];
				return rainbowBrackets();
			},
		},
		{
			keys: ["fontSize", "editorFont", "lineHeight"],
			compartments: [fontStyleCompartment],
			build() {
				return makeFontTheme();
			},
		},
		{
			keys: ["textWrap"],
			compartments: [wrapCompartment],
			build() {
				return makeWrapExtension();
			},
		},
		{
			keys: ["softTab", "tabSize"],
			compartments: [indentUnitCompartment, tabSizeCompartment],
			build() {
				const { indentExt, tabSizeExt } = makeIndentExtensions();
				return [indentExt, tabSizeExt];
			},
		},
		{
			keys: ["linenumbers", "relativeLineNumbers"],
			compartments: [lineNumberCompartment],
			build() {
				return makeLineNumberExtension();
			},
		},
		{
			keys: ["rtlText"],
			compartments: [rtlCompartment],
			build() {
				const rtl = !!appSettings?.value?.rtlText;
				return EditorView.theme({
					"&": { direction: rtl ? "rtl" : "ltr" },
				});
			},
		},
		{
			keys: ["showSpaces"],
			compartments: [whitespaceCompartment],
			build() {
				const show = !!appSettings?.value?.showSpaces;
				return show
					? [highlightWhitespace(), highlightTrailingWhitespace()]
					: [];
			},
		},
		{
			keys: ["fadeFoldWidgets"],
			compartments: [foldThemeCompartment],
			build() {
				const fade = !!appSettings?.value?.fadeFoldWidgets;
				if (!fade) return [];
				return EditorView.theme({
					".cm-gutter.cm-foldGutter .cm-gutterElement": {
						opacity: 0,
						pointerEvents: "none",
						transition: "opacity .12s ease",
					},
					".cm-gutter.cm-foldGutter:hover .cm-gutterElement, .cm-gutter.cm-foldGutter .cm-gutterElement:hover":
						{
							opacity: 1,
							pointerEvents: "auto",
						},
				});
			},
		},
		{
			keys: ["liveAutoCompletion"],
			compartments: [completionCompartment],
			build() {
				const live = !!appSettings?.value?.liveAutoCompletion;
				return autocompletion({ activateOnTyping: live });
			},
		},
	];

	function getBaseExtensionsFromOptions() {
		/** @type {import("@codemirror/state").Extension[]} */
		const exts = [];
		for (const spec of cmOptionSpecs) {
			const built = spec.build();
			if (spec.compartments.length === 1) {
				exts.push(spec.compartments[0].of(built));
			} else {
				const arr = Array.isArray(built) ? built : [built];
				for (let i = 0; i < spec.compartments.length; i++) {
					const comp = spec.compartments[i];
					const ext = arr[i];
					if (ext !== undefined) exts.push(comp.of(ext));
				}
			}
		}
		return exts;
	}

	function applyOptions(keys) {
		const filter = keys ? new Set(keys) : null;
		for (const spec of cmOptionSpecs) {
			if (filter && !spec.keys.some((k) => filter.has(k))) continue;
			const built = spec.build();
			const effects = [];
			if (spec.compartments.length === 1) {
				effects.push(spec.compartments[0].reconfigure(built));
			} else {
				const arr = Array.isArray(built) ? built : [built];
				for (let i = 0; i < spec.compartments.length; i++) {
					const comp = spec.compartments[i];
					const ext = arr[i] ?? [];
					effects.push(comp.reconfigure(ext));
				}
			}
			editor.dispatch({ effects });
		}
	}

	// Create minimal CodeMirror editor
	const editorState = EditorState.create({
		doc: "",
		extensions: [
			...createBaseExtensions(),
			getCommandKeymapExtension(),
			// Default theme
			themeCompartment.of(oneDark),
			fixedHeightTheme,
			search(),
			// Ensure read-only can be toggled later via compartment
			readOnlyCompartment.of(EditorState.readOnly.of(false)),
			// Editor options driven by settings via compartments
			...getBaseExtensionsFromOptions(),
			// Emmet abbreviation tracker and common keybindings
			abbreviationTracker(),
			wrapWithAbbreviation(),
			keymap.of([{ key: "Mod-e", run: expandAbbreviation }]),
		],
	});

	const editor = new EditorView({
		state: editorState,
		parent: $container,
	});

	await applyKeyBindings(editor);

	editor.execCommand = function (commandName) {
		if (!commandName) return false;
		return executeCommand(String(commandName), editor);
	};

	editor.commands = {
		addCommand(descriptor) {
			const command = registerExternalCommand(descriptor);
			refreshCommandKeymap(editor);
			return command;
		},
		removeCommand(name) {
			if (!name) return;
			removeExternalCommand(name);
			refreshCommandKeymap(editor);
		},
	};

	Object.defineProperty(editor.commands, "commands", {
		get() {
			const map = {};
			getRegisteredCommands().forEach((cmd) => {
				map[cmd.name] = cmd;
			});
			return map;
		},
	});

	// Provide minimal Ace-like API compatibility used by plugins
	/**
	 * Insert text at the current selection/cursor in the editor
	 * @param {string} text
	 * @returns {boolean} success
	 */
	editor.insert = function (text) {
		try {
			const { from, to } = editor.state.selection.main;
			const insertText = String(text ?? "");
			// Replace current selection and move cursor to end of inserted text
			editor.dispatch({
				changes: { from, to, insert: insertText },
				selection: {
					anchor: from + insertText.length,
					head: from + insertText.length,
				},
			});
			return true;
		} catch (_) {
			return false;
		}
	};

	// Set CodeMirror theme by id registered in our registry
	editor.setTheme = function (themeId) {
		try {
			const id = String(themeId || "");
			const theme = getThemeById(id) || getThemeById(id.replace(/-/g, "_"));
			const ext = theme?.getExtension?.() || [oneDark];
			editor.dispatch({ effects: themeCompartment.reconfigure(ext) });
			return true;
		} catch (_) {
			return false;
		}
	};

	/**
	 * Go to a specific line and column in the editor (CodeMirror implementation)
	 * Supports multiple input formats:
	 * - Simple line number: gotoLine(16) or gotoLine(16, 5)
	 * - Relative offsets: gotoLine("+5") or gotoLine("-3")
	 * - Percentages: gotoLine("50%") or gotoLine("25%")
	 * - Line:column format: gotoLine("16:5")
	 * - Mixed formats: gotoLine("+5:10") or gotoLine("50%:5")
	 *
	 * @param {number|string} line - Line number (1-based), or string with special formats
	 * @param {number} column - Column number (0-based) - only used with numeric line parameter
	 * @param {boolean} animate - Whether to animate (not used in CodeMirror, for compatibility)
	 * @returns {boolean} success
	 */
	editor.gotoLine = function (line, column = 0, animate = false) {
		try {
			const { state } = editor;
			const { doc } = state;

			let targetLine,
				targetColumn = column;

			// If line is a string, parse it for special formats
			if (typeof line === "string") {
				const match = /^([+-])?(\d+)?(:\d+)?(%)?$/.exec(line.trim());
				if (!match) {
					console.warn("Invalid gotoLine format:", line);
					return false;
				}

				const currentLine = doc.lineAt(state.selection.main.head);
				const [, sign, lineNum, colonColumn, percent] = match;

				// Parse column if specified in line:column format
				if (colonColumn) {
					targetColumn = Math.max(0, +colonColumn.slice(1) - 1); // Convert to 0-based
				}

				// Parse line number
				let parsedLine = lineNum ? +lineNum : currentLine.number;

				if (lineNum && percent) {
					// Percentage format: "50%" or "+10%"
					let percentage = parsedLine / 100;
					if (sign) {
						percentage =
							percentage * (sign === "-" ? -1 : 1) +
							currentLine.number / doc.lines;
					}
					targetLine = Math.round(doc.lines * percentage);
				} else if (lineNum && sign) {
					// Relative format: "+5" or "-3"
					targetLine =
						parsedLine * (sign === "-" ? -1 : 1) + currentLine.number;
				} else if (lineNum) {
					// Absolute line number
					targetLine = parsedLine;
				} else {
					// No line number specified, stay on current line
					targetLine = currentLine.number;
				}
			} else {
				// Simple numeric line parameter
				targetLine = line;
			}

			// Clamp line number to valid range
			const lineNum = Math.max(1, Math.min(targetLine, doc.lines));
			const docLine = doc.line(lineNum);

			// Clamp column to line length
			const col = Math.max(0, Math.min(targetColumn, docLine.length));
			const pos = docLine.from + col;

			// Move cursor and scroll into view
			editor.dispatch({
				selection: { anchor: pos, head: pos },
				effects: EditorView.scrollIntoView(pos, { y: "center" }),
			});
			editor.focus();
			return true;
		} catch (error) {
			console.error("Error in gotoLine:", error);
			return false;
		}
	};

	/**
	 * Get current cursor position)
	 * @returns {{row: number, column: number}} Cursor position
	 */
	editor.getCursorPosition = function () {
		try {
			const head = editor.state.selection.main.head;
			const cursor = editor.state.doc.lineAt(head);
			const line = cursor.number;
			const col = head - cursor.from;
			return { row: line, column: col };
		} catch (_) {
			return { row: 1, column: 0 };
		}
	};

	/**
	 * Move cursor to specific position
	 * @param {{row: number, column: number}} pos - Position to move to
	 */
	editor.moveCursorToPosition = function (pos) {
		try {
			const lineNum = Math.max(1, pos.row || 1);
			const col = Math.max(0, pos.column || 0);
			editor.gotoLine(lineNum, col);
		} catch (_) {
			// ignore
		}
	};

	/**
	 * Get the entire document value
	 * @returns {string} Document content
	 */
	editor.getValue = function () {
		try {
			return editor.state.doc.toString();
		} catch (_) {
			return "";
		}
	};

	/**
	 * Compatibility object for selection-related methods
	 */
	editor.selection = {
		/**
		 * Get current selection anchor
		 * @returns {number} Anchor position
		 */
		get anchor() {
			try {
				return editor.state.selection.main.anchor;
			} catch (_) {
				return 0;
			}
		},

		/**
		 * Get current selection range
		 * @returns {{start: {row: number, column: number}, end: {row: number, column: number}}} Selection range
		 */
		getRange: function () {
			try {
				const { from, to } = editor.state.selection.main;
				const fromLine = editor.state.doc.lineAt(from);
				const toLine = editor.state.doc.lineAt(to);
				return {
					start: {
						row: fromLine.number,
						column: from - fromLine.from,
					},
					end: {
						row: toLine.number,
						column: to - toLine.from,
					},
				};
			} catch (_) {
				return { start: { row: 1, column: 0 }, end: { row: 1, column: 0 } }; // Default to line 1
			}
		},

		/**
		 * Get cursor position
		 * @returns {{row: number, column: number}} Cursor position
		 */
		getCursor: function () {
			return editor.getCursorPosition();
		},
	};

	/**
	 * Get selected text or text under cursor (CodeMirror implementation)
	 * @returns {string} Selected text
	 */
	editor.getCopyText = function () {
		try {
			const { from, to } = editor.state.selection.main;
			if (from === to) return ""; // No selection
			return editor.state.doc.sliceString(from, to);
		} catch (_) {
			return "";
		}
	};

	// Helper: apply a file's content and language to the editor view
	function applyFileToEditor(file) {
		if (!file || file.type !== "editor") return;
		const baseExtensions = [
			...createBaseExtensions(),
			getCommandKeymapExtension(),
			// keep compartment in the state to allow dynamic theme changes later
			themeCompartment.of(oneDark),
			fixedHeightTheme,
			search(),
			// Keep dynamic compartments across state swaps
			...getBaseExtensionsFromOptions(),
		];
		const exts = [...baseExtensions];
		try {
			const langExtFn = file.currentLanguageExtension;
			let initialLang = [];
			if (typeof langExtFn === "function") {
				let result;
				try {
					result = langExtFn();
				} catch (_) {
					result = [];
				}
				// If the loader returns a Promise, reconfigure when it resolves
				if (result && typeof result.then === "function") {
					initialLang = [];
					result
						.then((ext) => {
							try {
								editor.dispatch({
									effects: languageCompartment.reconfigure(ext || []),
								});
							} catch (_) {}
						})
						.catch(() => {
							// ignore load errors; remain in plain text
						});
				} else {
					initialLang = result || [];
				}
			}
			// Ensure language compartment is present (empty -> plain text)
			exts.push(languageCompartment.of(initialLang));
		} catch (e) {
			// ignore language extension errors; fallback to plain text
		}

		// Emmet config: set syntax based on file/mode
		const syntax = getEmmetSyntaxForFile(file);
		exts.push(abbreviationTracker());
		exts.push(wrapWithAbbreviation());
		exts.push(keymap.of([{ key: "Mod-e", run: expandAbbreviation }]));
		exts.push(emmetConfig.of({ syntax }));

		// Color preview plugin when enabled
		if (appSettings.value.colorPreview) {
			exts.push(colorView(true));
		}

		// Apply read-only state based on file.editable/loading using Compartment
		try {
			const ro = !file.editable || !!file.loading;
			exts.push(readOnlyCompartment.of(EditorState.readOnly.of(ro)));
		} catch (e) {
			// safe to ignore; editor will remain editable by default
		}

		// Keep file.session in sync and handle caching/autosave
		exts.push(getDocSyncListener());

		// Preserve previous state for restoring selection/folds after swap
		const prevState = file.session || null;

		const doc = prevState ? prevState.doc.toString() : "";
		const state = EditorState.create({ doc, extensions: exts });
		file.session = state; // keep file.session in sync
		editor.setState(state);
		// Re-apply selected theme after state replacement
		const desiredTheme = appSettings?.value?.editorTheme;
		if (desiredTheme) editor.setTheme(desiredTheme);

		// Ensure dynamic compartments reflect current settings
		applyOptions();

		// Restore selection from previous state if available
		try {
			const sel = prevState?.selection;
			if (sel && Array.isArray(sel.ranges)) {
				const ranges = sel.ranges.map((r) => ({ from: r.from, to: r.to }));
				const mainIndex = sel.mainIndex ?? 0;
				restoreSelection(editor, { ranges, mainIndex });
			}
		} catch (_) {}

		// Restore folds from previous state if available
		try {
			const folds = prevState ? getAllFolds(prevState) : [];
			if (folds && folds.length) {
				restoreFolds(editor, folds);
			}
		} catch (_) {}

		// Restore last known scroll position if present
		if (
			typeof file.lastScrollTop === "number" ||
			typeof file.lastScrollLeft === "number"
		) {
			setScrollPosition(editor, file.lastScrollTop, file.lastScrollLeft);
		}
	}

	function getEmmetSyntaxForFile(file) {
		const mode = (file?.currentMode || "").toLowerCase();
		const name = (file?.filename || "").toLowerCase();
		const ext = name.includes(".") ? name.split(".").pop() : "";
		if (ext === "xml" || mode.includes("xml")) return "xml";
		if (ext === "jsx" || ext === "tsx") return "jsx";
		if (mode.includes("javascript") && (ext === "jsx" || ext === "tsx"))
			return "jsx";
		if (ext === "css" || mode.includes("css")) return "css";
		if (ext === "scss" || mode.includes("scss")) return "scss";
		if (ext === "sass" || mode.includes("sass")) return "sass";
		if (ext === "styl" || ext === "stylus" || mode.includes("styl"))
			return "stylus";
		if (ext === "php" || mode.includes("php")) return "html"; // treat PHP as HTML for Emmet
		if (ext === "vue" || mode.includes("vue")) return "html"; // Emmet inside templates
		if (ext === "html" || ext === "xhtml" || mode.includes("html"))
			return "html";
		// Defaults to html per Emmet docs
		return "html";
	}

	const $vScrollbar = ScrollBar({
		width: scrollbarSize,
		onscroll: onscrollV,
		onscrollend: onscrollVend,
		parent: $body,
	});
	const $hScrollbar = ScrollBar({
		width: scrollbarSize,
		onscroll: onscrollH,
		onscrollend: onscrollHEnd,
		parent: $body,
		placement: "bottom",
	});
	const manager = {
		files: [],
		onupdate: () => {},
		activeFile: null,
		addFile,
		editor,
		readOnlyCompartment,
		getFile,
		switchFile,
		hasUnsavedFiles,
		getEditorHeight,
		getEditorWidth,
		header: $header,
		container: $container,
		get isScrolling() {
			return isScrolling;
		},
		get openFileList() {
			if (!$openFileList) initFileTabContainer();
			return $openFileList;
		},
		get TIMEOUT_VALUE() {
			return TIMEOUT_VALUE;
		},
		on(types, callback) {
			if (!Array.isArray(types)) types = [types];
			types.forEach((type) => {
				if (!events[type]) events[type] = [];
				events[type].push(callback);
			});
		},
		off(types, callback) {
			if (!Array.isArray(types)) types = [types];
			types.forEach((type) => {
				if (!events[type]) return;
				events[type] = events[type].filter((c) => c !== callback);
			});
		},
		emit(event, ...args) {
			let detailedEvent;
			let detailedEventArgs = args.slice(1);
			if (event === "update") {
				const subEvent = args[0];
				if (subEvent) {
					detailedEvent = `${event}:${subEvent}`;
				}
			}
			events.emit(event, ...args);
			if (detailedEvent) {
				events.emit(detailedEvent, ...detailedEventArgs);
			}
		},
	};

	// TODO: Implement mode/language support for CodeMirror
	// editor.setSession(ace.createEditSession("", "ace/mode/text"));
	$body.append($container);
	initModes(); // Initialize CodeMirror modes
	await setupEditor();

	// Initialize theme from settings or fallback
	try {
		const desired = appSettings?.value?.editorTheme || "one_dark";
		editor.setTheme(desired);
	} catch (_) {}

	// Ensure initial options reflect settings
	applyOptions();

	$hScrollbar.onshow = $vScrollbar.onshow = updateFloatingButton.bind(
		{},
		false,
	);
	$hScrollbar.onhide = $vScrollbar.onhide = updateFloatingButton.bind({}, true);

	appSettings.on("update:textWrap", function () {
		updateMargin();
		applyOptions(["textWrap"]);
	});

	function updateEditorIndentationSettings() {
		applyOptions(["softTab", "tabSize"]);
	}

	function updateEditorStyleFromSettings() {
		applyOptions(["fontSize", "editorFont", "lineHeight"]);
	}

	function updateEditorWrapFromSettings() {
		applyOptions(["textWrap"]);
		if (appSettings.value.textWrap) {
			$hScrollbar.hide();
		}
	}

	function updateEditorLineNumbersFromSettings() {
		applyOptions(["linenumbers", "relativeLineNumbers"]);
	}

	appSettings.on("update:tabSize", function () {
		updateEditorIndentationSettings();
	});

	appSettings.on("update:softTab", function () {
		updateEditorIndentationSettings();
	});

	// Show spaces/tabs and trailing whitespace
	appSettings.on("update:showSpaces", function () {
		applyOptions(["showSpaces"]);
	});

	// Font size update for CodeMirror
	appSettings.on("update:fontSize", function () {
		updateEditorStyleFromSettings();
	});

	// Font family update for CodeMirror
	appSettings.on("update:editorFont", function () {
		updateEditorStyleFromSettings();
	});

	appSettings.on("update:openFileListPos", function (value) {
		initFileTabContainer();
		$vScrollbar.resize();
	});

	// appSettings.on("update:showPrintMargin", function (value) {
	// 	// manager.editor.setOption("showPrintMargin", value);
	// });

	appSettings.on("update:scrollbarSize", function (value) {
		$vScrollbar.size = value;
		$hScrollbar.size = value;
	});

	// Live autocompletion (activateOnTyping)
	appSettings.on("update:liveAutoCompletion", function () {
		applyOptions(["liveAutoCompletion"]);
	});

	appSettings.on("update:linenumbers", function () {
		updateMargin(true);
		updateEditorLineNumbersFromSettings();
	});

	// Line height update for CodeMirror
	appSettings.on("update:lineHeight", function () {
		updateEditorStyleFromSettings();
	});

	appSettings.on("update:relativeLineNumbers", function () {
		updateEditorLineNumbersFromSettings();
	});

	// appSettings.on("update:elasticTabstops", function (_value) {
	// 	// Not applicable in CodeMirror (Ace-era). No-op for now.
	// });

	appSettings.on("update:rtlText", function () {
		applyOptions(["rtlText"]);
	});

	// appSettings.on("update:hardWrap", function (_value) {
	// 	// Not applicable in CodeMirror (Ace-era). No-op for now.
	// });

	// appSettings.on("update:printMargin", function (_value) {
	// 	// Not applicable in CodeMirror (Ace-era). No-op for now.
	// });

	appSettings.on("update:colorPreview", function () {
		const file = manager.activeFile;
		if (file?.type === "editor") applyFileToEditor(file);
	});

	appSettings.on("update:showSideButtons", function () {
		updateMargin();
		updateSideButtonContainer();
	});

	appSettings.on("update:showAnnotations", function () {
		updateMargin(true);
	});

	appSettings.on("update:fadeFoldWidgets", function () {
		applyOptions(["fadeFoldWidgets"]);
	});

	// Toggle rainbow brackets
	appSettings.on("update:rainbowBrackets", function () {
		applyOptions(["rainbowBrackets"]);
	});

	// Keep file.session and cache in sync on every edit
	function getDocSyncListener() {
		return EditorView.updateListener.of((update) => {
			const file = manager.activeFile;
			if (!file || file.type !== "editor") return;

			// Only run expensive work when the document actually changed
			if (!update.docChanged) return;

			// Mirror latest state only on doc changes to avoid clobbering async loads
			try {
				file.session = update.state;
			} catch (_) {}

			// Debounced change handling (unsaved flag, cache, autosave)
			if (checkTimeout) clearTimeout(checkTimeout);
			if (autosaveTimeout) clearTimeout(autosaveTimeout);

			checkTimeout = setTimeout(async () => {
				const changed = await file.isChanged();
				file.isUnsaved = changed;
				try {
					await file.writeToCache();
				} catch (_) {}

				events.emit("file-content-changed", file);
				manager.onupdate("file-changed");
				manager.emit("update", "file-changed");

				const { autosave } = appSettings.value;
				if (file.uri && changed && autosave) {
					autosaveTimeout = setTimeout(() => {
						acode.exec("save", false);
					}, autosave);
				}

				file.markChanged = true;
			}, TIMEOUT_VALUE);
		});
	}

	// Register critical listeners
	manager.on(["file-loaded"], (file) => {
		if (!file) return;
		if (manager.activeFile?.id === file.id && file.type === "editor") {
			applyFileToEditor(file);
		}
	});

	manager.on(["update:read-only"], () => {
		const file = manager.activeFile;
		if (file?.type !== "editor") return;
		try {
			const ro = !file.editable || !!file.loading;
			editor.dispatch({
				effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)),
			});
		} catch (_) {
			// Fallback: full re-apply
			applyFileToEditor(file);
		}
	});

	// Attach doc-sync listener to the current editor instance
	try {
		editor.dispatch({
			effects: StateEffect.appendConfig.of(getDocSyncListener()),
		});
	} catch (_) {}

	return manager;

	/**
	 * Adds a file to the manager's file list and updates the UI.
	 * @param {File} file - The file to be added.
	 */
	function addFile(file) {
		if (manager.files.includes(file)) return;
		manager.files.push(file);
		manager.openFileList.append(file.tab);
		$header.text = file.name;
	}

	/**
	 * Sets up the editor with various configurations and event listeners.
	 * @returns {Promise<void>} A promise that resolves once the editor is set up.
	 */
	async function setupEditor() {
		// TODO: Get input element from CodeMirror
		// const textInput = editor.textInput.getElement();
		const settings = appSettings.value;
		const { leftMargin, textWrap, colorPreview, fontSize, lineHeight } =
			appSettings.value;
		const scrollMarginTop = 0;
		const scrollMarginLeft = 0;
		const scrollMarginRight = textWrap ? 0 : leftMargin;
		const scrollMarginBottom = 0;

		let checkTimeout = null;
		let autosaveTimeout;
		let scrollTimeout;
		const scroller = editor.scrollDOM;

		function handleEditorScroll() {
			if (!scroller) return;
			onscrolltop();
			onscrollleft();
			clearTimeout(scrollTimeout);
			isScrolling = true;
			scrollTimeout = setTimeout(() => {
				isScrolling = false;
			}, 100);
		}

		scroller?.addEventListener("scroll", handleEditorScroll, { passive: true });
		handleEditorScroll();

		// TODO: Implement focus event for CodeMirror
		// editor.on("focus", async () => {
		//	const { activeFile } = manager;
		//	activeFile.focused = true;
		//	keyboardHandler.on("keyboardShow", scrollCursorIntoView);
		//	if (isScrolling) return;
		//	$hScrollbar.hide();
		//	$vScrollbar.hide();
		// });

		// TODO: Implement blur event for CodeMirror
		// editor.on("blur", async () => {
		//	const { hardKeyboardHidden, keyboardHeight } =
		//		await getSystemConfiguration();
		//	const blur = () => {
		//		const { activeFile } = manager;
		//		activeFile.focused = false;
		//		activeFile.focusedBefore = false;
		//	};
		//	if (
		//		hardKeyboardHidden === HARDKEYBOARDHIDDEN_NO &&
		//		keyboardHeight < 100
		//	) {
		//		// external keyboard
		//		blur();
		//		return;
		//	}
		//	const onKeyboardHide = () => {
		//		keyboardHandler.off("keyboardHide", onKeyboardHide);
		//		blur();
		//	};
		//	keyboardHandler.on("keyboardHide", onKeyboardHide);
		// });

		// Change handling is implemented via CodeMirror updateListener (see getDocSyncListener())

		// TODO: Implement change annotation event for CodeMirror
		// editor.on("changeAnnotation", toggleProblemButton);

		// TODO: Implement resize event for CodeMirror
		// editor.renderer.on("resize", () => {
		//	$vScrollbar.resize($vScrollbar.visible);
		//	$hScrollbar.resize($hScrollbar.visible);
		// });

		// TODO: Implement scroll events for CodeMirror
		// editor.on("scrolltop", onscrolltop);
		// editor.on("scrollleft", onscrollleft);
		// TODO: Add keydown listeners to CodeMirror
		// textInput.addEventListener("keydown", (e) => {
		//	if (e.key === "Escape") {
		//		keydownState.esc = { value: true, target: textInput };
		//	}
		// });

		// TODO: Implement color preview for CodeMirror
		// if (colorPreview) {
		//	initColorView(editor);
		// }
		// TODO: Implement touch listeners for CodeMirror
		// touchListeners(editor);
		// TODO: Implement commands for CodeMirror
		// setCommands(editor);
		// TODO: Implement key bindings for CodeMirror
		// await setKeyBindings(editor);
		// TODO: Implement Emmet for CodeMirror
		// Emmet.setCore(window.emmet);
		// TODO: Implement font size for CodeMirror
		// editor.setFontSize(fontSize);
		// TODO: Implement highlight selected word for CodeMirror
		// editor.setHighlightSelectedWord(true);
		// TODO: Implement line height for CodeMirror
		// editor.container.style.lineHeight = lineHeight;

		// TODO: Implement all editor options for CodeMirror
		// ace.require("ace/ext/language_tools");
		// editor.setOption("animatedScroll", false);
		// editor.setOption("tooltipFollowsMouse", false);
		// editor.setOption("theme", settings.editorTheme);
		// editor.setOption("showGutter", settings.linenumbers || settings.showAnnotations);
		// editor.setOption("showLineNumbers", settings.linenumbers);
		// editor.setOption("enableEmmet", true);
		// editor.setOption("showInvisibles", settings.showSpaces);
		// editor.setOption("indentedSoftWrap", false);
		// editor.setOption("scrollPastEnd", 0.5);
		// editor.setOption("showPrintMargin", settings.showPrintMargin);
		// editor.setOption("relativeLineNumbers", settings.relativeLineNumbers);
		// editor.setOption("useElasticTabstops", settings.elasticTabstops);
		// editor.setOption("useTextareaForIME", settings.useTextareaForIME);
		// editor.setOption("rtlText", settings.rtlText);
		// editor.setOption("hardWrap", settings.hardWrap);
		// editor.setOption("spellCheck", settings.spellCheck);
		// editor.setOption("printMarginColumn", settings.printMargin);
		// editor.setOption("enableBasicAutocompletion", true);
		// editor.setOption("enableLiveAutocompletion", settings.liveAutoCompletion);
		// editor.setOption("copyWithEmptySelection", true);
		// editor.setOption("fadeFoldWidgets", settings.fadeFoldWidgets);
		// editor.setOption('enableInlineAutocompletion', settings.inlineAutoCompletion);

		updateMargin(true);
		updateSideButtonContainer();
		// TODO: Implement scroll margin for CodeMirror
		// editor.renderer.setScrollMargin(
		//	scrollMarginTop,
		//	scrollMarginBottom,
		//	scrollMarginLeft,
		//	scrollMarginRight,
		// );
	}

	/**
	 * Scrolls the cursor into view if it is not currently visible.
	 */
	// TODO: Implement cursor scrolling for CodeMirror
	function scrollCursorIntoView() {
		// keyboardHandler.off("keyboardShow", scrollCursorIntoView);
		// if (isCursorVisible()) return;
		// const { teardropSize } = appSettings.value;
		// editor.renderer.scrollCursorIntoView();
		// editor.renderer.scrollBy(0, teardropSize + 10);
		// editor._emit("scroll-intoview");
	}

	/**
	 * Checks if the cursor is visible within the Ace editor.
	 * @returns {boolean} - True if the cursor is visible, false otherwise.
	 */
	// TODO: Implement cursor visibility check for CodeMirror
	function isCursorVisible() {
		// const { editor, container } = manager;
		// const { teardropSize } = appSettings.value;
		// const cursorPos = editor.getCursorPosition();
		// const contentTop = container.getBoundingClientRect().top;
		// const contentBottom = contentTop + container.clientHeight;
		// const cursorTop = editor.renderer.textToScreenCoordinates(
		//	cursorPos.row,
		//	cursorPos.column,
		// ).pageY;
		// const cursorBottom = cursorTop + teardropSize + 10;
		// return cursorTop >= contentTop && cursorBottom <= contentBottom;
		return true; // Placeholder
	}

	/**
	 * Sets the vertical scroll value of the editor. This is called when the editor is scrolled horizontally using the scrollbar.
	 * @param {Number} value
	 */
	function onscrollV(value) {
		const scroller = editor?.scrollDOM;
		if (!scroller) return;
		const normalized = clamp01(value);
		const maxScroll = Math.max(
			scroller.scrollHeight - scroller.clientHeight,
			0,
		);
		preventScrollbarV = true;
		scroller.scrollTop = normalized * maxScroll;
		lastScrollTop = scroller.scrollTop;
	}

	/**
	 * Handles the onscroll event for the vend element.
	 */
	function onscrollVend() {
		preventScrollbarV = false;
		setVScrollValue();
	}

	/**
	 * Sets the horizontal scroll value of the editor. This is called when the editor is scrolled vertically using the scrollbar.
	 * @param {number} value - The scroll value.
	 */
	function onscrollH(value) {
		if (appSettings.value.textWrap) return;
		const scroller = editor?.scrollDOM;
		if (!scroller) return;
		const normalized = clamp01(value);
		const maxScroll = Math.max(scroller.scrollWidth - scroller.clientWidth, 0);
		preventScrollbarH = true;
		scroller.scrollLeft = normalized * maxScroll;
		lastScrollLeft = scroller.scrollLeft;
	}

	/**
	 * Handles the event when the horizontal scrollbar reaches the end.
	 */
	function onscrollHEnd() {
		preventScrollbarH = false;
		setHScrollValue();
	}

	/**
	 * Sets scrollbars value based on the editor's scroll position.
	 */
	function setHScrollValue() {
		if (appSettings.value.textWrap || preventScrollbarH) return;
		const scroller = editor?.scrollDOM;
		if (!scroller) return;
		const maxScroll = Math.max(scroller.scrollWidth - scroller.clientWidth, 0);
		if (maxScroll <= 0) {
			lastScrollLeft = 0;
			$hScrollbar.value = 0;
			return;
		}
		const scrollLeft = scroller.scrollLeft;
		if (scrollLeft === lastScrollLeft) return;
		lastScrollLeft = scrollLeft;
		const factor = scrollLeft / maxScroll;
		$hScrollbar.value = clamp01(factor);
	}

	/**
	 * Handles the scroll left event.
	 * Updates the horizontal scroll value and renders the horizontal scrollbar.
	 */
	function onscrollleft() {
		if (appSettings.value.textWrap) {
			$hScrollbar.hide();
			return;
		}
		const scroller = editor?.scrollDOM;
		if (!scroller) return;
		const maxScroll = Math.max(scroller.scrollWidth - scroller.clientWidth, 0);
		if (maxScroll <= 0) {
			$hScrollbar.hide();
			lastScrollLeft = 0;
			$hScrollbar.value = 0;
			return;
		}
		setHScrollValue();
		$hScrollbar.render();
	}

	/**
	 * Sets scrollbars value based on the editor's scroll position.
	 */
	function setVScrollValue() {
		if (preventScrollbarV) return;
		const scroller = editor?.scrollDOM;
		if (!scroller) return;
		const maxScroll = Math.max(
			scroller.scrollHeight - scroller.clientHeight,
			0,
		);
		if (maxScroll <= 0) {
			lastScrollTop = 0;
			$vScrollbar.value = 0;
			return;
		}
		const scrollTop = scroller.scrollTop;
		if (scrollTop === lastScrollTop) return;
		lastScrollTop = scrollTop;
		const factor = scrollTop / maxScroll;
		$vScrollbar.value = clamp01(factor);
	}

	/**
	 * Handles the scroll top event.
	 * Updates the vertical scroll value and renders the vertical scrollbar.
	 */
	function onscrolltop() {
		const scroller = editor?.scrollDOM;
		if (!scroller) return;
		const maxScroll = Math.max(
			scroller.scrollHeight - scroller.clientHeight,
			0,
		);
		if (maxScroll <= 0) {
			$vScrollbar.hide();
			lastScrollTop = 0;
			$vScrollbar.value = 0;
			return;
		}
		setVScrollValue();
		$vScrollbar.render();
	}

	function clamp01(value) {
		if (value <= 0) return 0;
		if (value >= 1) return 1;
		return value;
	}

	/**
	 * Updates the floating button visibility based on the provided show parameter.
	 * @param {boolean} [show=false] - Indicates whether to show the floating button.
	 */
	function updateFloatingButton(show = false) {
		const { $headerToggler } = acode;
		const { $toggler } = quickTools;

		if (show) {
			if (scrollBarVisibilityCount) --scrollBarVisibilityCount;

			if (!scrollBarVisibilityCount) {
				clearTimeout(timeoutHeaderToggler);
				clearTimeout(timeoutQuicktoolsToggler);

				if (appSettings.value.floatingButton) {
					$toggler.classList.remove("hide");
					root.appendOuter($toggler);
				}

				$headerToggler.classList.remove("hide");
				root.appendOuter($headerToggler);
			}

			return;
		}

		if (!scrollBarVisibilityCount) {
			if ($toggler.isConnected) {
				$toggler.classList.add("hide");
				timeoutQuicktoolsToggler = setTimeout(() => $toggler.remove(), 300);
			}
			if ($headerToggler.isConnected) {
				$headerToggler.classList.add("hide");
				timeoutHeaderToggler = setTimeout(() => $headerToggler.remove(), 300);
			}
		}

		++scrollBarVisibilityCount;
	}

	/**
	 * Toggles the visibility of the problem button based on the presence of annotations in the files.
	 */
	// TODO: Implement problem button toggle for CodeMirror
	function toggleProblemButton() {
		// const fileWithProblems = manager.files.find((file) => {
		//	if (file.type !== "editor") return false;
		//	const annotations = file?.session?.getAnnotations();
		//	return !!annotations.length;
		// });
		// if (fileWithProblems) {
		//	problemButton.show();
		// } else {
		//	problemButton.hide();
		// }
	}

	/**
	 * Updates the side button container based on the value of `showSideButtons` in `appSettings`.
	 * If `showSideButtons` is `false`, the side button container is removed from the DOM.
	 * If `showSideButtons` is `true`, the side button container is appended to the body element.
	 */
	function updateSideButtonContainer() {
		const { showSideButtons } = appSettings.value;
		if (!showSideButtons) {
			sideButtonContainer.remove();
			return;
		}

		$body.append(sideButtonContainer);
	}

	/**
	 * Updates the margin of the editor and optionally updates the gutter settings.
	 * @param {boolean} [updateGutter=false] - Whether to update the gutter settings.
	 */
	function updateMargin(updateGutter = false) {
		const { showSideButtons, linenumbers, showAnnotations } = appSettings.value;
		const top = 0;
		const bottom = 0;
		const right = showSideButtons ? 15 : 0;
		const left = linenumbers ? (showAnnotations ? 0 : -16) : 0;
		// TODO
		//editor.renderer.setMargin(top, bottom, left, right);

		if (!updateGutter) return;

		// editor.setOptions({
		// 	showGutter: linenumbers || showAnnotations,
		// 	showLineNumbers: linenumbers,
		// });
	}

	/**
	 * Switches the active file in the editor.
	 * @param {string} id - The ID of the file to switch to.
	 */
	function switchFile(id) {
		const { id: activeFileId } = manager.activeFile || {};
		if (activeFileId === id) return;

		const file = manager.getFile(id);

		manager.activeFile?.tab.classList.remove("active");

		// Hide previous content if it was non-editor
		if (manager.activeFile?.type !== "editor" && manager.activeFile?.content) {
			manager.activeFile.content.style.display = "none";
		}

		// Persist the previous editor's state before switching away
		const prev = manager.activeFile;
		if (prev?.type === "editor") {
			try {
				prev.session = editor.state;
			} catch (_) {}
			try {
				prev.lastScrollTop = editor.scrollDOM?.scrollTop || 0;
				prev.lastScrollLeft = editor.scrollDOM?.scrollLeft || 0;
			} catch (_) {}
		}

		manager.activeFile = file;

		if (file.type === "editor") {
			// Apply active file content and language to CodeMirror
			applyFileToEditor(file);
			$container.style.display = "block";

			$hScrollbar.hideImmediately();
			$vScrollbar.hideImmediately();

			setVScrollValue();
			if (!appSettings.value.textWrap) {
				setHScrollValue();
			}
		} else {
			$container.style.display = "none";
			if (file.content) {
				file.content.style.display = "block";
				if (!file.content.parentElement) {
					$container.parentElement.appendChild(file.content);
				}
			}
			// TODO: Implement selection clearing for CodeMirror
			if (manager.activeFile && manager.activeFile.type === "editor") {
				// manager.activeFile.session.selection.clearSelection();
			}
		}

		file.tab.classList.add("active");
		file.tab.scrollIntoView();

		if (file?.hideQuickTools) {
			root.classList.add("hide-floating-button");
			actions("set-height", { height: 0, save: false });
		} else {
			root.classList.remove("hide-floating-button");
			const quickToolsHeight =
				appSettings.value.quickTools !== undefined
					? appSettings.value.quickTools
					: 1;
			actions("set-height", { height: quickToolsHeight, save: true });
		}

		$header.text = file.filename;
		manager.onupdate("switch-file");
		events.emit("switch-file", file);
	}

	/**
	 * Initializes the file tab container.
	 */
	function initFileTabContainer() {
		let $list;

		if ($openFileList) {
			if ($openFileList.classList.contains("collapsible")) {
				$list = Array.from($openFileList.$ul.children);
			} else {
				$list = Array.from($openFileList.children);
			}
			$openFileList.remove();
		}

		// show open file list in header
		const { openFileListPos } = appSettings.value;
		if (
			openFileListPos === appSettings.OPEN_FILE_LIST_POS_HEADER ||
			openFileListPos === appSettings.OPEN_FILE_LIST_POS_BOTTOM
		) {
			if (!$openFileList?.classList.contains("open-file-list")) {
				$openFileList = <ul className="open-file-list"></ul>;
			}
			if ($list) $openFileList.append(...$list);

			if (openFileListPos === appSettings.OPEN_FILE_LIST_POS_BOTTOM) {
				$container.parentElement.insertAdjacentElement(
					"afterend",
					$openFileList,
				);
			} else {
				$header.insertAdjacentElement("afterend", $openFileList);
			}

			root.classList.add("top-bar");

			const oldAppend = $openFileList.append;
			$openFileList.append = (...args) => {
				oldAppend.apply($openFileList, args);
			};
		} else {
			$openFileList = list(strings["active files"]);
			$openFileList.classList.add("file-list");
			if ($list) $openFileList.$ul.append(...$list);
			$openFileList.expand();

			const oldAppend = $openFileList.$ul.append;
			$openFileList.append = (...args) => {
				oldAppend.apply($openFileList.$ul, args);
			};

			const files = sidebarApps.get("files");
			files.insertBefore($openFileList, files.firstElementChild);
			root.classList.remove("top-bar");
		}

		root.setAttribute("open-file-list-pos", openFileListPos);
		manager.emit("int-open-file-list", openFileListPos);
	}

	/**
	 * Checks if there are any unsaved files in the manager.
	 * @returns {number} The number of unsaved files.
	 */
	function hasUnsavedFiles() {
		const unsavedFiles = manager.files.filter((file) => file.isUnsaved);
		return unsavedFiles.length;
	}

	/**
	 * Gets a file from the file manager
	 * @param {string|number} checkFor
	 * @param {"id"|"name"|"uri"} [type]
	 * @returns {File}
	 */
	function getFile(checkFor, type = "id") {
		return manager.files.find((file) => {
			switch (type) {
				case "id":
					if (file.id === checkFor) return true;
					return false;
				case "name":
					if (file.filename === checkFor) return true;
					return false;
				case "uri":
					if (file.uri === checkFor) return true;
					return false;
				default:
					return false;
			}
		});
	}

	/**
	 * Gets the height of the editor
	 * @param {AceAjax.Editor} editor
	 * @returns
	 */
	// TODO: Implement editor height calculation for CodeMirror
	function getEditorHeight(editor) {
		try {
			const sd = editor?.scrollDOM;
			if (!sd) return 0;
			// Return the total vertical scrollable range
			const total = sd.scrollHeight || 0;
			const viewport = sd.clientHeight || 0;
			return Math.max(total - viewport, 0);
		} catch (_) {
			return 0;
		}
	}

	/**
	 * Gets the height of the editor
	 * @param {AceAjax.Editor} editor
	 * @returns
	 */
	// TODO: Implement editor width calculation for CodeMirror
	function getEditorWidth(editor) {
		try {
			const sd = editor?.scrollDOM;
			if (!sd) return 0;
			// Return the total horizontal scrollable range
			const total = sd.scrollWidth || 0;
			const viewport = sd.clientWidth || 0;
			let width = Math.max(total - viewport, 0);
			if (!appSettings.value.textWrap) {
				const { leftMargin = 0 } = appSettings.value;
				width += leftMargin || 0;
			}
			return width;
		} catch (_) {
			return 0;
		}
	}
}

export default EditorManager;
