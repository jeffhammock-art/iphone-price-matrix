const GRADE_BY_VALUE: Record<string, string> = {
  "12": "Fair",
  "11": "Good",
  "10": "Excellent",
  "9": "Premium",
};

export function canonicalize(groupId: string, label: string, trackingValue?: string | number | null): string {
  const raw = (label ?? "").trim();
  const value = trackingValue == null ? "" : String(trackingValue).trim();
  const combined = `${raw} ${value}`.trim();

  if (groupId === "grades") {
    if (GRADE_BY_VALUE[raw]) return GRADE_BY_VALUE[raw];
    if (GRADE_BY_VALUE[value]) return GRADE_BY_VALUE[value];
    const named = combined.match(/\b(fair|good|excellent|premium)\b/i);
    if (named?.[1]) return titleCase(named[1]);
    return raw;
  }

  if (groupId === "battery") {
    const text = combined.toLowerCase();
    if (/\bnew\b/.test(text)) return "New";
    if (/\bgreat\b/.test(text)) return "Great";
    if (/standard/.test(text)) return "Standard";
    if (/\bgood\b/.test(text)) return "Good";
    return raw;
  }

  if (groupId === "storage") {
    const tb = combined.match(/([\d.]+)\s*tb/i);
    if (tb?.[1]) return `${tb[1]} TB`;
    const gb = combined.match(/(\d+)\s*gb/i) || combined.match(/\b(\d{2,4})\b/);
    if (gb?.[1]) return `${gb[1]} GB`;
    return raw;
  }

  if (groupId === "dual_sim") {
    const text = combined.toLowerCase();
    if (text.includes("dual")) return "Dual Physical SIM";
    if (text.includes("physical") && text.includes("esim")) return "Physical SIM + eSIM";
    if (text.includes("esim")) return "eSIM";
    return raw;
  }

  return raw;
}

export function labelsEqual(
  groupId: string,
  left: string,
  right: string,
  leftValue?: string | number | null,
  rightValue?: string | number | null,
): boolean {
  return canonicalize(groupId, left, leftValue).toLowerCase() === canonicalize(groupId, right, rightValue).toLowerCase();
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
