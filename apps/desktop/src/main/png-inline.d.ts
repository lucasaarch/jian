/** Vite inlines the file as a data URL, so the packaged app carries no loose sprite. */
declare module '*.png?inline' {
  const url: string;
  export default url;
}
