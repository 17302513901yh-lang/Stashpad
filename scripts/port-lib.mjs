// Dev tool: copies one file from a permissively licensed upstream project into third_party/,
// with a provenance header, the license text, a provenance log line and a THIRD_PARTY_NOTICES.md row.
// Refuses any license that is not on the allow list, before it reads anything.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const ALLOWED_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"];

export class PortError extends Error {}

export function checkLicense(license) {
  const value = String(license ?? "").trim();
  if (value === "") {
    throw new PortError(`refused: no license given. Allowed: ${ALLOWED_LICENSES.join(", ")}.`);
  }
  if (!ALLOWED_LICENSES.includes(value)) {
    const copyleft = /GPL|SSPL|BUSL|Commercial|Proprietary|Source-available/i.test(value)
      ? " This is a copyleft or source-available license."
      : "";
    throw new PortError(`refused: license "${value}" is not allowed.${copyleft} Allowed: ${ALLOWED_LICENSES.join(", ")}.`);
  }
  return value;
}

function safeDest(root, dest) {
  const parts = String(dest).split(/[\\/]/);
  if (dest === "" || isAbsolute(dest) || /^[a-zA-Z]:/.test(dest) || parts.includes("..")) {
    throw new PortError(`refused: destination "${dest}" must be a relative path inside third_party/`);
  }
  return join(root, "third_party", dest);
}

function cell(text) {
  return String(text).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

// Replaces the placeholder row, adds a row for a new project, or adds a file to an existing row.
export function updateNotices(noticesText, entry) {
  const { project, sourceUrl, commit, license, copyright, dest } = entry;
  let lines = noticesText.split("\n");
  lines = lines.map((line) =>
    line.startsWith("**Status:") ? "**Status: third-party code is included. Each file is listed in the table below.**" : line,
  );
  lines = lines.filter((line) => !line.startsWith("| _(none yet)_"));

  const rowStart = `| ${project} |`;
  const existing = lines.findIndex((line) => line.startsWith(rowStart));
  if (existing >= 0) {
    const parts = lines[existing].split("|");
    const last = parts.length - 2;
    parts[last] = ` ${parts[last].trim()}, \`${dest}\` `;
    lines[existing] = parts.join("|");
    return lines.join("\n");
  }

  const separator = lines.findIndex((line) => /^\|-+\|/.test(line));
  if (separator < 0) throw new PortError("refused: THIRD_PARTY_NOTICES.md has no table to add to");
  const row = `| ${cell(project)} | ${cell(sourceUrl)} | ${cell(commit)} | ${cell(license)} | ${cell(copyright)} | \`${cell(dest)}\` |`;
  lines.splice(separator + 1, 0, row);
  return lines.join("\n");
}

export function portFile(opts) {
  const { root, project, sourceUrl, commit, license, copyright, upstreamPath, sourceFile, dest, licenseFile, modifiedNote, today } = opts;

  // The license gate runs first, so a refused license never reads or writes a file.
  const spdx = checkLicense(license);

  const required = { project, sourceUrl, commit, copyright, upstreamPath, sourceFile, dest, licenseFile, modifiedNote, today };
  const missing = Object.entries(required)
    .filter(([, value]) => !value || !String(value).trim())
    .map(([key]) => key);
  if (missing.length > 0) throw new PortError(`refused: missing ${missing.join(", ")}`);

  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new PortError("refused: project must be a lowercase slug such as mem0 or graphiti");
  }
  if (!/^https:\/\//.test(sourceUrl)) throw new PortError("refused: source URL must start with https://");
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new PortError("refused: commit must be a full or short hex hash");

  const target = safeDest(root, dest);
  if (existsSync(target)) throw new PortError(`refused: ${dest} already exists`);
  if (!existsSync(sourceFile)) throw new PortError(`refused: source file not found: ${sourceFile}`);
  if (!existsSync(licenseFile)) {
    throw new PortError("refused: license text not found. Pass the upstream LICENSE file with --license-file.");
  }

  const notices = join(root, "THIRD_PARTY_NOTICES.md");
  const noticesText = readFileSync(notices, "utf8");
  const newNotices = updateNotices(noticesText, { project, sourceUrl, commit, license: spdx, copyright, dest });

  const header = [
    `// Ported from ${project} (${sourceUrl}) at commit ${commit}.`,
    `// Original file: ${upstreamPath}. License: ${spdx}. Copyright: ${copyright}.`,
    `// Modified for Stashpad: ${modifiedNote}`,
    "// The original copyright header follows unchanged.",
    "",
  ].join("\n");

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, header + readFileSync(sourceFile, "utf8"), { flag: "wx" });

  const licenseName = `${project}-${spdx}.txt`;
  const licenseTarget = join(root, "third_party", "licenses", licenseName);
  if (!existsSync(licenseTarget)) writeFileSync(licenseTarget, readFileSync(licenseFile, "utf8"));

  writeFileSync(notices, newNotices);
  appendFileSync(
    join(root, "third_party", "provenance.jsonl"),
    JSON.stringify({ project, source_url: sourceUrl, commit, license: spdx, upstream_path: upstreamPath, dest, date: today }) + "\n",
  );

  return { dest: `third_party/${dest}`, license: spdx, licenseText: `third_party/licenses/${licenseName}` };
}
