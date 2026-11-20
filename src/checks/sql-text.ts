// Small readers for the SQL that migrations are written in. Not a parser: just enough
// structure to tell a value passed with `USING` from one pasted into the statement, a function
// body from the trigger that calls it, and a policy from a comment that mentions one.
// Everything here is pure and works on plain strings.

/** Index just past a single-quoted literal that opens at `start`. `''` is an escaped quote. */
function endOfQuoted(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/**
 * Index just past a dollar-quoted string (`$$…$$`, `$q$…$q$`) that opens at `start`, or -1
 * when there is none there. `$1` is a positional parameter, not a quote, and a `$` inside an
 * identifier (`my$var`) is part of the name.
 */
function endOfDollarQuoted(sql: string, start: number): number {
  if (sql[start] !== '$' || /[\w$]/.test(sql[start - 1] ?? ' ')) return -1;
  const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(start, start + 64))?.[0];
  if (!tag) return -1;
  const close = sql.indexOf(tag, start + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

/**
 * Replaces comments with spaces of the same length, so every index and line number computed on
 * the result still points at the same place in the original file. A rule that read
 * `-- never put user_metadata in a policy` as a policy would be accusing the comment that warns
 * against the mistake.
 */
export function blankComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'") {
      const end = endOfQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += ' '.repeat(end - i);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Walks `sql` from `from`, skipping quoted literals and nested parentheses, and returns the
 * first index where `stop` holds at depth zero — or the end of the string.
 */
function scanTopLevel(sql: string, from: number, stop: (i: number) => boolean): number {
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'") {
      i = endOfQuoted(sql, i);
      continue;
    }
    const dollar = endOfDollarQuoted(sql, i);
    if (dollar !== -1) {
      i = dollar;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0 && stop(i)) return i;
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && stop(i)) return i;
    i++;
  }
  return sql.length;
}

/** The index of the `)` that closes the `(` at `open`. */
export function closingParen(sql: string, open: number): number {
  return scanTopLevel(sql, open + 1, (i) => sql[i] === ')');
}

/** The index of the `;` that ends the statement starting at `from`, or the end of the string. */
export function statementEnd(sql: string, from: number): number {
  return scanTopLevel(sql, from, (i) => sql[i] === ';');
}

/** Splits on commas that are not inside parentheses or a literal. */
export function splitTopLevel(sql: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    const comma = scanTopLevel(sql, start, (i) => sql[i] === ',');
    parts.push(sql.slice(start, comma));
    if (comma >= sql.length) return parts;
    start = comma + 1;
  }
}

/** Cuts `expr` at the first top-level occurrence of one of `words`, matched as whole words. */
export function cutAtKeyword(expr: string, words: string[]): string {
  const re = new RegExp(`^(?:${words.join('|')})\\b`, 'i');
  const end = scanTopLevel(
    expr,
    0,
    (i) => /[a-z]/i.test(expr[i]!) && !/[\w$]/.test(expr[i - 1] ?? ' ') && re.test(expr.slice(i)),
  );
  return expr.slice(0, end);
}

/** Replaces the contents of every literal, single- or dollar-quoted, with an empty `''`. */
export function blankLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      out += "''";
      i = endOfQuoted(sql, i);
      continue;
    }
    const dollar = endOfDollarQuoted(sql, i);
    if (dollar !== -1) {
      out += "''";
      i = dollar;
      continue;
    }
    out += sql[i++];
  }
  return out;
}

/** Removes every call to one of `fns` — the call and its arguments — from `sql`. */
export function dropCalls(sql: string, fns: string[]): string {
  const re = new RegExp(`\\b(?:${fns.join('|')})\\s*\\(`, 'gi');
  let out = sql;
  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(out);
    if (!m) return out;
    const open = m.index + m[0].length - 1;
    out = `${out.slice(0, m.index)}''${out.slice(closingParen(out, open) + 1)}`;
  }
}

/** The text of a literal like `'…'`, `E'…'` or `$q$…$q$`, or null when `arg` is not one. */
export function literalText(arg: string): string | null {
  const quoted = /^\s*[eE]?'((?:[^']|'')*)'\s*$/.exec(arg);
  if (quoted) return quoted[1]!.replace(/''/g, "'");
  const dollar = /^\s*(\$(?:[A-Za-z_]\w*)?\$)([\s\S]*)\1\s*$/.exec(arg);
  return dollar ? dollar[2]! : null;
}

/** 1-based line number of `index` in `text`. */
export function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** `"public"`, `public` and `Public` are the same name to Postgres; quotes aside, compare lowercased. */
export function bareName(name: string | undefined): string | null {
  if (!name) return null;
  const n = name.replace(/\s*\.\s*$/, '').trim();
  return n.startsWith('"') ? n.slice(1, -1) : n.toLowerCase();
}

export interface SqlParam {
  /** Lowercased name, or null when the parameter is declared by type alone. */
  name: string | null;
  /** 1-based position, which is how an unnamed parameter is referenced: `$1`. */
  pos: number;
  type: string;
}

export interface SqlFunction {
  name: string;
  schema: string | null;
  params: SqlParam[];
  language: string | null;
  securityDefiner: boolean;
  /** The body between its dollar quotes, with comments blanked. */
  body: string;
  /** Where `body` starts in the file. */
  bodyStart: number;
  /** Where the `CREATE` keyword is. */
  index: number;
}

const CREATE_FUNCTION =
  /create\s+(?:or\s+replace\s+)?function\s+((?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)\s*\(/gi;
const PARAM_MODE = /^(?:in|out|inout|variadic)$/i;

function parseParams(args: string): SqlParam[] {
  const params: SqlParam[] = [];
  splitTopLevel(args).forEach((raw, i) => {
    const decl = raw
      .replace(/\s+default\s+[\s\S]*$/i, '')
      .replace(/\s*=[\s\S]*$/, '')
      .trim();
    if (!decl) return;
    const tokens = decl.split(/\s+/);
    if (PARAM_MODE.test(tokens[0]!)) {
      if (/^out$/i.test(tokens[0]!)) return;
      tokens.shift();
    }
    const whole = tokens.join(' ');
    // A declaration that is all type (`text`, `character varying`) has no name.
    if (tokens.length === 1 || isTextType(whole)) {
      params.push({ name: null, pos: i + 1, type: whole });
    } else {
      params.push({ name: bareName(tokens[0]), pos: i + 1, type: tokens.slice(1).join(' ') });
    }
  });
  return params;
}

/** True for the string types a caller can put SQL into. */
export function isTextType(type: string): boolean {
  return /^(?:pg_catalog\.)?(?:text|varchar|character\s+varying|char|character|citext|bpchar)(?:\s*\(\s*\d+\s*\))?(?:\s*\[\s*\d*\s*\])*$/i.test(
    type.trim(),
  );
}

/**
 * Every `CREATE FUNCTION` in `sql` whose body is dollar-quoted. Old-style single-quoted bodies
 * are skipped rather than half-read: a body whose quotes are all doubled cannot be told apart
 * from the literals inside it without a real lexer.
 */
export function parseFunctions(sql: string): SqlFunction[] {
  const text = blankComments(sql);
  const out: SqlFunction[] = [];
  CREATE_FUNCTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREATE_FUNCTION.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closingParen(text, open);
    const params = parseParams(text.slice(open + 1, close));

    const tag = /\$([A-Za-z_]\w*)?\$/g;
    tag.lastIndex = close;
    const opening = tag.exec(text);
    if (!opening) continue;
    const delimiter = opening[0];
    const bodyStart = opening.index + delimiter.length;
    const bodyEnd = text.indexOf(delimiter, bodyStart);
    if (bodyEnd === -1) continue;
    // A dollar quote that belongs to a later statement is not this function's body.
    if (text.slice(close, opening.index).includes(';')) continue;

    const end = statementEnd(text, bodyEnd + delimiter.length);
    const attributes = `${text.slice(close, opening.index)} ${text.slice(bodyEnd + delimiter.length, end)}`;
    out.push({
      name: bareName(m[2]) ?? '',
      schema: bareName(m[1]),
      params,
      language: /\blanguage\s+'?(\w+)'?/i.exec(attributes)?.[1]?.toLowerCase() ?? null,
      securityDefiner: /\bsecurity\s+definer\b/i.test(attributes),
      body: text.slice(bodyStart, bodyEnd),
      bodyStart,
      index: m.index,
    });
    CREATE_FUNCTION.lastIndex = end;
  }
  return out;
}
