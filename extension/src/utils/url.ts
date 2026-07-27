/** Returns the hostname of a URL, or null when it is not a parseable web URL. */
export function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Content scripts only run on http(s); chrome:// and file:// tabs are inert. */
export function isScriptablePage(url: string | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}
