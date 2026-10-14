declare module 'cartocolor' {
  const palettes: Record<string, Record<string, string[]> & { tags?: string[] }>;
  export = palettes;
}
