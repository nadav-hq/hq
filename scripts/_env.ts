import { readFileSync } from "node:fs";

/** Minimal .env loader for local runs. Railway/Vercel set real env vars; nothing here overrides them. */
export function loadDotEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env var ${name} (see .env.example)`);
    process.exit(2);
  }
  return v;
}
