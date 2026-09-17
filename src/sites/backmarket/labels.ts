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

  if (groupId === "screen_size") {
    // "13.0" / "14.0" / "13" → '13"', '14"'
    const num = combined.match(/(\d+(?:\.\d+)?)/);
    if (num?.[1]) {
      const inches = Number(num[1]);
      return `${Number.isInteger(inches) ? inches : inches.toFixed(1)}"`;
    }
    return raw;
  }

  if (groupId === "memory") {
    // "8" / "16 GB" → "8 GB", "16 GB"
    const gb = combined.match(/(\d+)\s*gb/i) || combined.match(/\b(\d{1,3})\b/);
    if (gb?.[1]) return `${gb[1]} GB`;
    return raw;
  }

  if (groupId === "processor_type_and_graphic_card") {
    // "Apple M1 8-core - 8-core GPU" → "Apple M1"
    const chip = combined.match(/Apple\s+M\d+(?:\s*Pro|\s*Max|\s*Ultra)*/i);
    if (chip?.[0]) return chip[0].replace(/\s+/g, " ").trim();
    return raw;
  }

  if (groupId === "keyboard_type_language") {
    return raw; // e.g. "QWERTY - English" — kept verbatim
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
