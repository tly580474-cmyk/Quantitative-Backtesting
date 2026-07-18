import { describe, expect, it } from 'vitest';
import { parseLooseJson } from './looseJson.js';

describe('parseLooseJson', () => {
  it('parses JSON and JSONP responses', () => {
    expect(parseLooseJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseLooseJson('jQuery_news({"result":{"items":[1]}});')).toEqual({ result: { items: [1] } });
  });

  it('rejects empty and unsupported bodies', () => {
    expect(() => parseLooseJson('')).toThrow('Empty response body');
    expect(() => parseLooseJson('<html>blocked</html>')).toThrow('Unsupported JSON/JSONP');
  });
});
