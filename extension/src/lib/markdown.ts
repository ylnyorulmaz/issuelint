/** Pure Markdown post-processing shared by the content script and tests. */

/** Turndown pads list markers ("-   item", "[x]  task"); tighten them outside fenced code. */
function tightenLists(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line
        .replace(/^(\s*)([-*+]|\d+\.) {2,}(?=\S)/, "$1$2 ")
        .replace(/^(\s*(?:[-*+]|\d+\.) \[[ xX]\]) {2,}/, "$1 ");
    })
    .join("\n");
}

export function cleanupMarkdown(input: string): string {
  return tightenLists(input.replace(/\r\n?/g, "\n"))
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    // Links and images with no visible text or no target are noise.
    .replace(/!?\[\s*\]\([^)]*\)/g, "")
    .replace(/\[([^\]\n]+)\]\(\s*\)/g, "$1")
    // Bullets left empty after stripping UI controls.
    .replace(/^[ \t]*[-*+][ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Truncates on a line boundary where possible, so a cut never splits a word mid-line. */
export function truncateMarkdown(markdown: string, max: number): { text: string; truncated: boolean } {
  if (markdown.length <= max) return { text: markdown, truncated: false };
  const slice = markdown.slice(0, max);
  const lastBreak = slice.lastIndexOf("\n");
  const text = (lastBreak > max * 0.8 ? slice.slice(0, lastBreak) : slice).trimEnd();
  return { text, truncated: true };
}
