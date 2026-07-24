const CLS_HOST_PATTERN = /(^|\.)cls\.cn$/i;
const CLS_SHARE_PATH_PATTERN = /^\/share\/article\/(\d+)\/?$/;

export function normalizeNewsUrl(value?: string | null): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const articleId = CLS_HOST_PATTERN.test(url.hostname)
      ? url.pathname.match(CLS_SHARE_PATH_PATTERN)?.[1]
      : undefined;
    return articleId ? `https://www.cls.cn/detail/${articleId}` : raw;
  } catch {
    return raw;
  }
}
