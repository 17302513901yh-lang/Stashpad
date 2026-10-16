// Stashpad memory file format: parser and validator.
// Dependency-free. Only a scalar subset of YAML is supported on purpose,
// so that files stay easy to read, diff and check by hand.

export const REQUIRED_KEYS = [
  "id",
  "kind",
  "created_at",
  "valid_from",
  "valid_to",
  "supersedes",
  "superseded_by",
  "source_type",
  "source_ref",
  "trust",
  "last_confirmed_at",
];

export const KINDS = ["fact", "preference", "decision", "task"];

export const SOURCE_TYPES = ["user", "agent", "tool", "web"];

// Trust is derived from the source and never chosen by the writer.
// Nothing an agent or a web page writes can claim to be user-stated.
export const TRUST_BY_SOURCE = {
  user: "user-stated",
  agent: "agent-inferred",
  tool: "external",
  web: "external",
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isValidId = (id) => typeof id === "string" && ID_PATTERN.test(id);

function parseScalar(raw) {
  if (raw === "" || raw === "null") return null;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}

export function parseMemory(text) {
  const errors = [];
  const meta = Object.create(null);
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  if (lines[0] !== "---") {
    errors.push("file must start with a line containing only ---");
    return { meta, body: "", errors };
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    errors.push("frontmatter is not closed with a line containing only ---");
    return { meta, body: "", errors };
  }

  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const match = /^([a-z_]+):(.*)$/.exec(line);
    if (!match) {
      errors.push(`cannot read frontmatter line: "${line}"`);
      continue;
    }
    const key = match[1];
    if (key in meta) {
      errors.push(`duplicate key: ${key}`);
      continue;
    }
    meta[key] = parseScalar(match[2].trim());
  }

  const body = lines.slice(end + 1).join("\n").trim();
  return { meta, body, errors };
}

function isRealDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const isDate = (value) =>
  typeof value === "string" && DATE_PATTERN.test(value) && isRealDate(value);

const isOptionalId = (value) =>
  value === null || (typeof value === "string" && ID_PATTERN.test(value));

export function validateMemory(text, expectedId) {
  const { meta, body, errors } = parseMemory(text);

  for (const key of Object.keys(meta)) {
    if (!REQUIRED_KEYS.includes(key)) errors.push(`unknown key: ${key}`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in meta)) errors.push(`missing key: ${key}`);
  }

  if (typeof meta.id !== "string" || !ID_PATTERN.test(meta.id)) {
    errors.push("id must be lowercase letters, digits and hyphens");
  } else if (expectedId !== undefined && meta.id !== expectedId) {
    errors.push(`id "${meta.id}" must match the file name "${expectedId}"`);
  }

  if (!KINDS.includes(meta.kind)) {
    errors.push(`kind must be one of: ${KINDS.join(", ")}`);
  }

  if (!SOURCE_TYPES.includes(meta.source_type)) {
    errors.push(`source_type must be one of: ${SOURCE_TYPES.join(", ")}`);
  } else if (meta.trust !== TRUST_BY_SOURCE[meta.source_type]) {
    errors.push(
      `trust must be "${TRUST_BY_SOURCE[meta.source_type]}" for source_type "${meta.source_type}"`,
    );
  }

  if (typeof meta.source_ref !== "string" || meta.source_ref === "") {
    errors.push("source_ref must be a short, non-empty description");
  }

  for (const key of ["created_at", "valid_from", "last_confirmed_at"]) {
    if (!isDate(meta[key])) errors.push(`${key} must be a real date as YYYY-MM-DD`);
  }
  if (meta.valid_to !== null && !isDate(meta.valid_to)) {
    errors.push("valid_to must be a real date as YYYY-MM-DD, or null");
  }
  if (isDate(meta.valid_from) && isDate(meta.valid_to) && meta.valid_to < meta.valid_from) {
    errors.push("valid_to must not be before valid_from");
  }

  if (!isOptionalId(meta.supersedes)) errors.push("supersedes must be an id, or null");
  if (!isOptionalId(meta.superseded_by)) errors.push("superseded_by must be an id, or null");
  if (meta.supersedes !== null && meta.supersedes === meta.id) {
    errors.push("a memory cannot supersede itself");
  }
  if (meta.superseded_by !== null && meta.valid_to === null) {
    errors.push("superseded_by is set, so valid_to must be a date");
  }

  if (body === "") errors.push("body must contain the memory text");

  return { meta, errors };
}

// files: [{ name: "some-id.md", text: "..." }]
// Checks each file alone, then checks that supersedes and superseded_by
// point to memories that exist in the same set.
export function validateDocuments(files) {
  const problems = [];
  const parsed = files.map((file) => {
    const expectedId = file.name.replace(/\.md$/, "");
    const { meta, errors } = validateMemory(file.text, expectedId);
    for (const message of errors) problems.push({ file: file.name, message });
    return { file, meta };
  });

  const ids = new Set(
    parsed.map(({ meta }) => meta.id).filter((id) => typeof id === "string"),
  );
  for (const { file, meta } of parsed) {
    for (const key of ["supersedes", "superseded_by"]) {
      const ref = meta[key];
      if (typeof ref === "string" && !ids.has(ref)) {
        problems.push({ file: file.name, message: `${key} points to unknown id "${ref}"` });
      }
    }
  }
  return problems;
}
