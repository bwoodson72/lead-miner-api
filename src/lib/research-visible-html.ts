const HIDDEN_BLOCK = /<(div|section|article|aside|header|footer|nav|main|span|p|h[1-6]|ul|ol|li)\b(?=[^>]*(?:\shidden(?:\s|=|>)|\saria-hidden=["']true["']|\sstyle=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["']|\sclass=["'][^"']*(?:elementor-hidden-(?:desktop|tablet|mobile)|\bd-none\b|\bis-hidden\b|\bvisually-hidden\b|\bsr-only\b|\bscreen-reader-text\b)[^"']*["']))[^>]*>[\s\S]*?<\/\1>/gi;

export function stripStaticHiddenMarkup(html: string) {
  let cleaned = html
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  for (let i = 0; i < 5; i += 1) {
    const next = cleaned.replace(HIDDEN_BLOCK, " ");
    if (next === cleaned) break;
    cleaned = next;
  }

  return cleaned;
}
