// Records the README demo: runs real Stashpad commands in a fresh temporary store, captures their
// real output and renders it as an animated SVG terminal (lines appear one after another).
// Run: node scripts/demo-svg.mjs  ->  docs/demo/demo.svg
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "stashpad.mjs");
const dir = join(mkdtempSync(join(tmpdir(), "stashpad-demo-")), "memories");
const env = { ...process.env, STASHPAD_DIR: dir, STASHPAD_GLOBAL_DIR: join(dir, "..", "global") };

const steps = [
  { show: 'stashpad save db --kind decision --source-type user --source-ref "team chat" \\\n    --text "We use Postgres 16. No ORM: plain SQL migrations in db/migrations."',
    args: ["save", "db", "--kind", "decision", "--source-type", "user", "--source-ref", "team chat", "--text", "We use Postgres 16. No ORM: plain SQL migrations in db/migrations."] },
  { show: "stashpad pin db", args: ["pin", "db"] },
  { show: 'stashpad save cache --kind fact --source-type agent --source-ref "read src/cache.ts" \\\n    --text "Redis caches sessions for 15 minutes."',
    args: ["save", "cache", "--kind", "fact", "--source-type", "agent", "--source-ref", "read src/cache.ts", "--text", "Redis caches sessions for 15 minutes."] },
  { show: "stashpad accept cache", args: ["accept", "cache"] },
  { comment: "# what the prompt hook adds to a request like this:" },
  { show: "stashpad recall \"add a postgres migration for the sessions cache\"", args: ["recall", "add a postgres migration for the sessions cache"] },
  { comment: "# after /compact, the session start hook brings the pinned rule back:" },
  { show: "stashpad brief", args: ["brief", "--max-chars", "600"] },
];

const lines = [];
for (const step of steps) {
  if (step.comment) {
    lines.push({ text: step.comment, kind: "comment" });
    continue;
  }
  step.show.split("\n").forEach((l, i) => lines.push({ text: i === 0 ? `$ ${l}` : l, kind: "cmd" }));
  const out = execFileSync(process.execPath, [bin, ...step.args], { env, encoding: "utf8" }).trimEnd();
  for (const l of out.split("\n")) lines.push({ text: l.replace(dir, "~/project/.stashpad/memories"), kind: "out" });
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wrap = (s, n) => {
  const parts = [];
  let rest = s;
  while (rest.length > n) {
    let cut = rest.lastIndexOf(" ", n);
    if (cut < n * 0.6) cut = n;
    parts.push(rest.slice(0, cut));
    rest = `  ${rest.slice(cut).trimStart()}`;
  }
  parts.push(rest);
  return parts;
};
const rows = lines.flatMap((l) => wrap(l.text, 92).map((t) => ({ ...l, text: t })));
const lineH = 18;
const top = 44;
const height = top + rows.length * lineH + 20;
const step = 0.35;
const color = { cmd: "#e6edf3", out: "#9fb3c8", comment: "#7ee787" };
const body = rows
  .map((r, i) => {
    return `<text x="16" y="${top + i * lineH}" fill="${color[r.kind]}" style="animation-delay:${(i * step).toFixed(2)}s">${esc(r.text)}</text>`;
  })
  .join("\n");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="${height}" viewBox="0 0 820 ${height}" role="img" aria-label="Stashpad demo: real output of save, pin, review, recall and brief">
<style>
text { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; opacity: 0; animation: show 0.2s ease-out forwards; }
@keyframes show { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { text { animation: none; opacity: 1; } }
</style>
<rect width="820" height="${height}" rx="10" fill="#0d1117"/>
<circle cx="20" cy="18" r="6" fill="#ff5f56"/><circle cx="40" cy="18" r="6" fill="#ffbd2e"/><circle cx="60" cy="18" r="6" fill="#27c93f"/>
<text x="90" y="22" fill="#6e7681" style="opacity:1;animation:none">stashpad — real output, recorded by scripts/demo-svg.mjs</text>
${body}
</svg>
`;
writeFileSync(join(root, "docs", "demo", "demo.svg"), svg);
console.log(`wrote docs/demo/demo.svg (${rows.length} lines)`);
