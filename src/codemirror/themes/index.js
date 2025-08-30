import { oneDark } from "@codemirror/theme-one-dark";
import aura, { config as auraConfig, auraHighlightStyle } from "./aura";
import dracula, { config as draculaConfig, draculaHighlightStyle } from "./dracula";
import githubDark, { config as githubDarkConfig, githubDarkHighlightStyle } from "./githubDark";
import githubLight, { config as githubLightConfig, githubLightHighlightStyle } from "./githubLight";
import monokai, { config as monokaiConfig, monokaiHighlightStyle } from "./monokai";
import noctisLilac, { config as noctisLilacConfig, noctisLilacHighlightStyle } from "./noctisLilac";
import solarizedDark, { config as solarizedDarkConfig, solarizedDarkHighlightStyle } from "./solarizedDark";
import solarizedLight, {
    config as solarizedLightConfig,
    solarizedLightHighlightStyle,
} from "./solarizedLight";
import tokyoNight, { config as tokyoNightConfig, tokyoNightHighlightStyle } from "./tokyoNight";
import tokyoNightDay, { config as tokyoNightDayConfig, tokyoNightDayHighlightStyle } from "./tokyoNightDay";
import vscodeDark, { config as vscodeDarkConfig, vscodeDarkHighlightStyle } from "./vscodeDark";

// Registry of CodeMirror editor themes
// key: id, value: { id, caption, isDark, getExtension: () => Extension[] }
const themes = new Map();

export function addTheme(id, caption, isDark, getExtension, getHighlightStyle, getSurface) {
    const key = String(id).toLowerCase();
    if (themes.has(key)) return;
    themes.set(key, {
        id: key,
        caption: caption || id,
        isDark: !!isDark,
        getExtension,
    });
    // Allow optional highlight style registration for static highlighting consumers
    try {
        if (typeof getHighlightStyle === "function") {
            const style = getHighlightStyle();
            if (style) highlightStyles.set(key, style);
        }
        if (typeof getSurface === "function") {
            const s = getSurface();
            if (s && (s.background || s.foreground)) themeSurfaces.set(key, s);
        }
    } catch (_) {}
}

export function getThemes() {
	return Array.from(themes.values());
}

export function getThemeById(id) {
	if (!id) return null;
	return themes.get(String(id).toLowerCase()) || null;
}

export function removeTheme(id) {
    if (!id) return;
    themes.delete(String(id).toLowerCase());
}

// HighlightStyle lookup by theme id for static highlighting consumers
const highlightStyles = new Map([
    [String(auraConfig.name).toLowerCase(), auraHighlightStyle],
    [String(draculaConfig.name).toLowerCase(), draculaHighlightStyle],
    [String(githubDarkConfig.name).toLowerCase(), githubDarkHighlightStyle],
    [String(githubLightConfig.name).toLowerCase(), githubLightHighlightStyle],
    [String(monokaiConfig.name).toLowerCase(), monokaiHighlightStyle],
    [String(noctisLilacConfig.name).toLowerCase(), noctisLilacHighlightStyle],
    [String(solarizedDarkConfig.name).toLowerCase(), solarizedDarkHighlightStyle],
    [String(solarizedLightConfig.name).toLowerCase(), solarizedLightHighlightStyle],
    [String(tokyoNightConfig.name).toLowerCase(), tokyoNightHighlightStyle],
    [String(tokyoNightDayConfig.name).toLowerCase(), tokyoNightDayHighlightStyle],
    [String(vscodeDarkConfig.name).toLowerCase(), vscodeDarkHighlightStyle],
    // one_dark doesn't expose a HighlightStyle; fall back handled by consumer
]);

export function getHighlightStyleById(id) {
    if (!id) return null;
    return highlightStyles.get(String(id).toLowerCase()) || null;
}

// Register built-ins
addTheme("one_dark", "One Dark", true, () => [oneDark]);
addTheme(auraConfig.name, "Aura", !!auraConfig.dark, () => aura());
addTheme(
	noctisLilacConfig.name,
	noctisLilacConfig.caption || "Noctis Lilac",
	!!noctisLilacConfig.dark,
	() => noctisLilac(),
);
addTheme(draculaConfig.name, "Dracula", !!draculaConfig.dark, () => dracula());
addTheme(githubDarkConfig.name, "GitHub Dark", !!githubDarkConfig.dark, () =>
	githubDark(),
);
addTheme(githubLightConfig.name, "GitHub Light", !!githubLightConfig.dark, () =>
	githubLight(),
);
addTheme(
	solarizedDarkConfig.name,
	"Solarized Dark",
	!!solarizedDarkConfig.dark,
	() => solarizedDark(),
);
addTheme(
	solarizedLightConfig.name,
	"Solarized Light",
	!!solarizedLightConfig.dark,
	() => solarizedLight(),
);
addTheme(
	tokyoNightDayConfig.name,
	"Tokyo Night Day",
	!!tokyoNightDayConfig.dark,
	() => tokyoNightDay(),
);
addTheme(tokyoNightConfig.name, "Tokyo Night", !!tokyoNightConfig.dark, () =>
	tokyoNight(),
);
addTheme(noctisLilacConfig.name, "Noctis Lilac", !!noctisLilacConfig.dark, () =>
	noctisLilac(),
);
addTheme(monokaiConfig.name, "Monokai", !!monokaiConfig.dark, () => monokai());
addTheme(vscodeDarkConfig.name, "VS Code Dark", !!vscodeDarkConfig.dark, () =>
	vscodeDark(),
);

export default { getThemes, getThemeById, addTheme, removeTheme };

// Provide base surface colors for static, non-editor areas (like readme code blocks)
const themeSurfaces = new Map([
    [String(auraConfig.name).toLowerCase(), { background: auraConfig.background, foreground: auraConfig.foreground, selection: auraConfig.selection }],
    [String(draculaConfig.name).toLowerCase(), { background: draculaConfig.background, foreground: draculaConfig.foreground, selection: draculaConfig.selection }],
    [String(githubDarkConfig.name).toLowerCase(), { background: githubDarkConfig.background, foreground: githubDarkConfig.foreground, selection: githubDarkConfig.selection }],
    [String(githubLightConfig.name).toLowerCase(), { background: githubLightConfig.background, foreground: githubLightConfig.foreground, selection: githubLightConfig.selection }],
    [String(monokaiConfig.name).toLowerCase(), { background: monokaiConfig.background, foreground: monokaiConfig.foreground, selection: monokaiConfig.selection }],
    [String(noctisLilacConfig.name).toLowerCase(), { background: noctisLilacConfig.background, foreground: noctisLilacConfig.foreground, selection: noctisLilacConfig.selection }],
    [String(solarizedDarkConfig.name).toLowerCase(), { background: solarizedDarkConfig.background, foreground: solarizedDarkConfig.foreground, selection: solarizedDarkConfig.selection }],
    [String(solarizedLightConfig.name).toLowerCase(), { background: solarizedLightConfig.background, foreground: solarizedLightConfig.foreground, selection: solarizedLightConfig.selection }],
    [String(tokyoNightConfig.name).toLowerCase(), { background: tokyoNightConfig.background, foreground: tokyoNightConfig.foreground, selection: tokyoNightConfig.selection }],
    [String(tokyoNightDayConfig.name).toLowerCase(), { background: tokyoNightDayConfig.background, foreground: tokyoNightDayConfig.foreground, selection: tokyoNightDayConfig.selection }],
    [String(vscodeDarkConfig.name).toLowerCase(), { background: vscodeDarkConfig.background, foreground: vscodeDarkConfig.foreground, selection: vscodeDarkConfig.selection }],
]);

export function getThemeSurfaceById(id) {
    if (!id) return null;
    return themeSurfaces.get(String(id).toLowerCase()) || null;
}
