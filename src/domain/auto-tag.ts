// Deterministic, dependency-free tag extraction from normalized write
// content — see openspec/changes/add-auto-tagging. Scans content for four
// token shapes (code-shaped tokens, file paths, repo shorthand, @-mentions)
// and emits slugified candidate tags that already satisfy `TagSchema`
// (`^[a-zA-Z0-9-]+$`, max 100 chars, `src/domain/schemas.ts`) without any
// change to tag validation. No LLM call, no network — pattern matching only,
// following the regex-list-of-patterns-as-policy style of
// `SECRET_PATTERNS`/`INVALIDATION_PATTERNS` in `./normalize.ts`.

interface RawMatch {
  text: string;
  start: number;
  end: number;
}

// Markdown inline-code spans are the strongest signal a token is a
// deliberate identifier, not prose.
const INLINE_CODE_RE = /`([^`\n]{2,80})`/;

// Identifier-shaped bare words: camelCase, PascalCase, SCREAMING_SNAKE_CASE /
// snake_case, and dotted config paths (e.g. `search.ranking.enabled`).
// Each requires a 5-char floor (applied post-match) to cut noise from short
// accidental matches (`eBay`, `iOS`-style two-token words).
const CAMEL_CASE_RE = /\b[a-z]+[A-Z][a-zA-Z0-9]*\b/;
const PASCAL_CASE_RE = /\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b/;
const SNAKE_CASE_RE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/;
// Every dotted segment must start with a letter, which is what keeps
// version strings like `v1.2.3` (second segment `2` starts with a digit)
// from matching.
const DOTTED_ID_RE = /\b[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){1,3}\b/;

const IDENTIFIER_MIN_LENGTH = 5;

// Slash-containing, extension-terminated file paths, e.g.
// `src/pipeline/index.ts`.
const FILE_PATH_RE = /\b[\w.-]*\/[\w./-]*\.[A-Za-z0-9]{1,10}\b/;

// Closed set of bare dotted filenames matched without a slash requirement,
// so a path mentioned without its directory still tags.
const BARE_FILENAMES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
  '.env',
  '.gitignore',
  '.eslintrc.json',
  'vitest.config.ts',
  'eslint.config.js',
];

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bounded by lookaround (not `\b`) because several filenames start with `.`,
// which is not a word character — a `\b` boundary would never land there.
const BARE_FILENAME_RE = new RegExp(
  `(?<![\\w./-])(?:${BARE_FILENAMES
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegexLiteral)
    .join('|')})(?![\\w./-])`,
);

// Exactly one `/`, two non-empty segments. Repo-shorthand tokens whose
// trailing segment carries a recognized extension are excluded below —
// those are file paths instead.
const REPO_SHORTHAND_RE = /\b[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\b/;

const FILE_EXTENSION_SUFFIX_RE = /\.[A-Za-z0-9]{1,10}$/;

// Negative lookbehind excludes `user@domain.com` (email) and `foo@bar`
// mid-identifier cases — the char immediately before `@` must not be a word
// character, `.`, or another `@`.
const MENTION_RE = /(?<![\w.@])@[a-zA-Z0-9_-]{2,39}\b/;

function execAll(pattern: RegExp, content: string): RawMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const matches: RawMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const text = m[1] ?? m[0];
    matches.push({ text, start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) {
      re.lastIndex += 1;
    }
  }
  return matches;
}

function overlapsAny(candidate: RawMatch, spans: RawMatch[]): boolean {
  return spans.some(span => candidate.start < span.end && span.start < candidate.end);
}

function collectCodeShapedTokens(content: string): RawMatch[] {
  const inlineCode = execAll(INLINE_CODE_RE, content);
  const identifiers = [
    ...execAll(CAMEL_CASE_RE, content),
    ...execAll(PASCAL_CASE_RE, content),
    ...execAll(SNAKE_CASE_RE, content),
    ...execAll(DOTTED_ID_RE, content),
  ].filter(match => match.text.length >= IDENTIFIER_MIN_LENGTH);
  return [...inlineCode, ...identifiers];
}

function collectFilePaths(content: string): RawMatch[] {
  return [...execAll(FILE_PATH_RE, content), ...execAll(BARE_FILENAME_RE, content)];
}

function collectRepoShorthand(content: string, filePaths: RawMatch[]): RawMatch[] {
  return execAll(REPO_SHORTHAND_RE, content).filter(match => {
    const trailing = match.text.split('/')[1] ?? '';
    if (FILE_EXTENSION_SUFFIX_RE.test(trailing)) return false;
    // A shorter slash token that is a prefix of a longer file-path match
    // (e.g. `src/pipeline` inside `src/pipeline/index.ts`) must not also
    // surface as repo shorthand.
    return !overlapsAny(match, filePaths);
  });
}

function collectMentions(content: string): RawMatch[] {
  return execAll(MENTION_RE, content);
}

/**
 * Normalizes a raw matched token into a `TagSchema`-compliant slug:
 * lowercased, `@` mapped to an `at-` prefix, every run of non-`[a-z0-9]`
 * characters collapsed to a single `-`, leading/trailing `-` trimmed,
 * truncated to 100 chars. Returns `null` when the result is shorter than
 * 2 characters (degenerate match, dropped).
 */
export function slugifyAutoTag(raw: string): string | null {
  let s = raw.toLowerCase();
  if (s.startsWith('@')) {
    s = `at-${s.slice(1)}`;
  }
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s.length > 100) {
    s = s.slice(0, 100).replace(/-+$/, '');
  }
  if (s.length < 2) return null;
  return s;
}

/**
 * Extracts deterministic, content-derived tag candidates from normalized
 * write content. Patterns run independently over the same content in
 * priority order — code-shaped tokens (inline-code spans, then
 * camelCase/PascalCase/snake_case/dotted identifiers), file paths, repo
 * shorthand, then @-mentions — and results are deduplicated post-slug
 * preserving first-seen priority order, then truncated to `maxTags`.
 */
export function extractAutoTags(content: string, maxTags: number): string[] {
  if (maxTags <= 0) return [];

  const filePaths = collectFilePaths(content);
  const categories: RawMatch[][] = [
    collectCodeShapedTokens(content),
    filePaths,
    collectRepoShorthand(content, filePaths),
    collectMentions(content),
  ];

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    for (const match of category) {
      const slug = slugifyAutoTag(match.text);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      tags.push(slug);
      if (tags.length >= maxTags) return tags;
    }
  }
  return tags;
}
