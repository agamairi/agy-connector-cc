export function parseArgs(argv, config = {}) {
  const values = new Set(config.valueOptions ?? []),
    booleans = new Set(config.booleanOptions ?? []);
  const aliases = config.aliasMap ?? {},
    options = {},
    positionals = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (passthrough || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    const long = token.startsWith("--"),
      [raw, inline] = (long ? token.slice(2) : token.slice(1)).split("=", 2);
    const key = aliases[raw] ?? raw;
    if (booleans.has(key)) {
      options[key] = inline === undefined ? true : inline !== "false";
      continue;
    }
    if (values.has(key)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${long ? "--" : "-"}${raw}`);
      options[key] = value;
      if (inline === undefined) i += 1;
      continue;
    }
    positionals.push(token);
  }
  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "",
    quote = null,
    escaping = false;
  for (const character of String(raw ?? "")) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}
