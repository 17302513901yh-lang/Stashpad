// Pure JavaScript BM25 ranking. Dependency-free, computed on each search (no index on disk).
const K1 = 1.2;
const B = 0.75;

// Lowercase words of two or more letters or digits. Unicode aware, so Dutch works too.
export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

// Light plural folding, so "tools" finds "tool" and "policies" finds "policy".
// It is deliberately small: it is not a full stemmer, and it is applied to both query and text.
export function stem(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function termsOf(text) {
  return tokenize(text).map(stem);
}

// Meaningful words for comparing two memories: stemmed, and at least four letters long.
export function keyTerms(text) {
  return termsOf(text).filter((term) => term.length >= 4);
}

// docs: [{ id, text }]. Returns [{ id, score }] for documents that match at least one term,
// best match first. Ties are ordered by id so results are stable.
export function bm25Rank(docs, query) {
  const queryTerms = [...new Set(termsOf(query))];
  if (queryTerms.length === 0) return [];

  const tokenized = docs.map((doc) => termsOf(doc.text));
  const count = docs.length;
  const totalLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0);
  const avgLength = count > 0 && totalLength > 0 ? totalLength / count : 1;

  const documentFrequency = new Map();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const results = [];
  docs.forEach((doc, index) => {
    const tokens = tokenized[index];
    const frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term);
      const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      const lengthNorm = 1 - B + (B * tokens.length) / avgLength;
      score += (idf * frequency * (K1 + 1)) / (frequency + K1 * lengthNorm);
    }

    if (score > 0) results.push({ id: doc.id, score });
  });

  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
