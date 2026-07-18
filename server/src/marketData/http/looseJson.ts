export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty response body');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const match = trimmed.match(/^[^(]*\(([\s\S]*)\);?$/);
  if (!match) throw new Error('Unsupported JSON/JSONP response');
  return JSON.parse(match[1]);
}
