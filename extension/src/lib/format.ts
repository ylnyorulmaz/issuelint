/** Pure display helpers (unit-tested). */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function gapLabel(n: number): string {
  return plural(n, "Potential gap", "Potential gaps");
}

export function charsLabel(n: number, limit: number): string {
  return `${n.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} ${plural(limit, "character", "characters")}`;
}

export function gatesLabel(n: number): string {
  return `${n} ${plural(n, "gate", "gates")}`;
}

/** Short backend name for pills. */
export function backendLabel(mode: "quick_scan" | "analyze_v2" | "custom"): string {
  return mode === "quick_scan" ? "Quick Scan" : mode === "analyze_v2" ? "Decision v2" : "Custom";
}
