/** The five accents. Each has a light and a dark rendering in app/styles/themes.css. */
export const themes = [
  { id: 'strelizia', name: 'Strelizia', pilot: 'Zero Two', color: 'Red' },
  { id: 'delphinium', name: 'Delphinium', pilot: 'Ichigo', color: 'Blue' },
  { id: 'argentea', name: 'Argentea', pilot: 'Miku', color: 'Pink' },
  { id: 'genista', name: 'Genista', pilot: 'Kokoro', color: 'Green' },
  { id: 'chlorophytum', name: 'Chlorophytum', pilot: 'Ikuno', color: 'Purple' },
] as const;

export type ThemeId = (typeof themes)[number]['id'];
export const themeKey = 'jian.theme';
export const isTheme = (value: unknown): value is ThemeId => themes.some(({ id }) => id === value);

/** Light or dark, or whatever the system says — the default, so a first visit matches the OS. */
export const modes = ['system', 'light', 'dark'] as const;

export type Mode = (typeof modes)[number];
export const modeKey = 'jian.mode';
export const isMode = (value: unknown): value is Mode => modes.some((mode) => mode === value);

// Runs in the head before the first paint, so a dark page never flashes white; the gateway
// hashes inline scripts in its CSP.
export const themeBootstrap = `try{var t=localStorage.getItem('${themeKey}');if(${JSON.stringify(themes.map(({ id }) => id))}.includes(t))document.documentElement.dataset.theme=t;var m=localStorage.getItem('${modeKey}');if(${JSON.stringify(modes)}.includes(m))document.documentElement.dataset.mode=m}catch{}`;
