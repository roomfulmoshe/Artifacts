// Lex-aware repair for partial JSX/TSX streams.
//
// Walks the source tracking string/comment state, JSX-vs-generic context,
// and a stack of pending closers (brackets and JSX tags). Truncates back
// to the most recent "clean" position when the tail is mid-string,
// mid-comment, or inside an unfinished tag, then appends the closers
// needed to make the result parseable. Returns null if irreparable.

type Closer = "}" | ")" | "]" | { jsx: string }; // jsx: tag name; "" for fragment

const FALLBACK_APP = `\nexport default function App() {\n  return null;\n}\n`;

export function repairCode(raw: string): string | null {
  if (!raw) return null;
  const src = raw.replace(/\s+$/, "");
  if (!src) return null;

  const stack: Closer[] = [];
  let inLine = false;
  let inBlock = false;
  let str: '"' | "'" | "`" | null = null;
  let truncate = false;
  // lastClean: the index AFTER which we are at a clean boundary (not mid-string,
  // not mid-comment, not inside a JSX tag <... currently being parsed).
  let lastClean = 0;
  // Snapshot of stack at lastClean — so we know what to close from there.
  let lastCleanStack: Closer[] = [];

  const snapshotClean = (i: number) => {
    lastClean = i;
    lastCleanStack = stack.slice();
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        snapshotClean(i + 1);
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
        snapshotClean(i);
        continue;
      }
      i++;
      continue;
    }
    if (str) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === str) {
        str = null;
        i++;
        snapshotClean(i);
        continue;
      }
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      // Inside JSX text (between tags) quotes are literal characters, NOT
      // string delimiters. Treating apostrophes in text like "Dijkstra's
      // algorithm" or "It's a wave" as string opens used to mis-pair with
      // apostrophes in real JS strings (e.g. useState('start')), corrupt
      // the bracket/JSX stack, and produce a truncated body with spurious
      // </div> closers appended. We're in JSX-text context whenever the
      // top of the stack is a JSX entry (i.e. an open tag we haven't
      // closed yet) — anything inside a `{ ... }` expression goes back to
      // normal JS rules because `{` pushes a string closer onto the stack.
      const top = stack[stack.length - 1];
      const inJsxText = top !== undefined && typeof top !== "string";
      if (inJsxText) {
        i++;
        snapshotClean(i);
        continue;
      }
      str = ch as '"' | "'" | "`";
      i++;
      continue;
    }

    // `</foo>` is unambiguously JSX (slash after `<` has no other meaning at
    // statement/expression position outside strings). For `<foo>` and `<>`
    // disambiguate against TS generics by looking at the preceding context.
    if (ch === "<" && (next === "/" || isJsxOpen(src, i))) {
      const consumed = consumeJsxTag(src, i, stack);
      if (consumed === -1) {
        truncate = true;
        break;
      }
      i = consumed;
      snapshotClean(i);
      continue;
    }

    if (ch === "{") {
      stack.push("}");
      i++;
      snapshotClean(i);
      continue;
    }
    if (ch === "(") {
      stack.push(")");
      i++;
      snapshotClean(i);
      continue;
    }
    if (ch === "[") {
      stack.push("]");
      i++;
      snapshotClean(i);
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      // Pop matching bracket (skip JSX entries).
      for (let j = stack.length - 1; j >= 0; j--) {
        const c = stack[j];
        if (typeof c === "string" && c === ch) {
          stack.splice(j, 1);
          break;
        }
        if (typeof c === "string") break; // mismatched; leave alone, parser will fail
      }
      i++;
      snapshotClean(i);
      continue;
    }

    i++;
    snapshotClean(i);
  }

  // Truncate if we're mid-something at EOF.
  let body: string;
  let activeStack: Closer[];
  if (str || inBlock || truncate) {
    body = src.slice(0, lastClean);
    activeStack = lastCleanStack;
  } else {
    body = src;
    activeStack = stack;
  }

  // Build closing tail. Insert `null` to avoid creating an empty `()` / `[]`
  // expression, leaving a dangling operator without a RHS, or returning
  // `undefined` from a component (which throws in React 18).
  let tail = "";
  let lastChar = lastNonSpace(body);
  const bareReturn = /(?:^|[^A-Za-z0-9_$])return\s*$/.test(body);
  if (needsExpressionFiller(lastChar) || bareReturn) {
    tail += "null";
    lastChar = "l";
  }
  for (let k = activeStack.length - 1; k >= 0; k--) {
    const c = activeStack[k];
    if (typeof c === "string") {
      tail += c;
      lastChar = c;
    } else {
      tail += c.jsx === "" ? "</>" : `</${c.jsx}>`;
      lastChar = ">";
    }
  }

  let out = body + tail;

  // Ensure there is something default-exported so Sandpack's entry point
  // can `import App from "./App"` without crashing the bundler.
  if (!/export\s+default/.test(out)) {
    if (/function\s+App\s*\(/.test(out)) {
      out += "\nexport default App;";
    } else {
      out += FALLBACK_APP;
    }
  }

  return out;
}

function lastNonSpace(s: string): string {
  for (let i = s.length - 1; i >= 0; i--) {
    if (!/\s/.test(s[i])) return s[i];
  }
  return "";
}

// Does the previous non-space char leave a dangling operator that needs a RHS?
// Trailing commas inside (), [], {} are fine in modern JS, so we don't fill those.
function needsExpressionFiller(prev: string): boolean {
  if (!prev) return false;
  if (prev === "(" || prev === "[") return true;
  // Operators that demand a right-hand side; conservative subset to avoid
  // false positives on `return\n(` (handled by the `(` rule above) and JSX `>`.
  return /[=+\-*/%&|^?:!~<]/.test(prev) && prev !== ">";
}

// Decide whether a `<` at position `i` starts a JSX element vs. a TS generic
// or comparison operator. Look at the previous non-whitespace char/keyword.
function isJsxOpen(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];

  // After identifier/closing-bracket: likely a TS generic call site like
  // `useState<number>` or a comparison. Skip — unless the identifier is a
  // keyword that introduces an expression. Note: a preceding `>` (the close
  // of another JSX tag) is fine — that means we're in JSX children context.
  if (/[A-Za-z0-9_$)\]]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    const word = src.slice(k + 1, j + 1);
    if (word === "return" || word === "yield" || word === "await") return true;
    return false;
  }

  // After `=>`, `=`, `(`, `[`, `{`, `,`, `;`, `?`, `:`, `&&`, `||`, `!`, or
  // a preceding `>`: JSX.
  return true;
}

// Parse a JSX tag starting at `<` index `i`. Pushes the appropriate closer
// onto `stack` (or pops one for closing tags). Returns the index after the
// tag, or -1 if the tag is incomplete (no matching `>`).
function consumeJsxTag(src: string, i: number, stack: Closer[]): number {
  const next = src[i + 1];

  // Closing tag </Name> or </>.
  if (next === "/") {
    const end = src.indexOf(">", i + 2);
    if (end === -1) return -1;
    // Find topmost JSX entry and pop. (Don't try to match by name — be lenient.)
    for (let j = stack.length - 1; j >= 0; j--) {
      if (typeof stack[j] !== "string") {
        stack.splice(j, 1);
        break;
      }
    }
    return end + 1;
  }

  // Fragment <>.
  if (next === ">") {
    stack.push({ jsx: "" });
    return i + 2;
  }

  // Opening tag <Name ...>. Read tag name.
  let n = i + 1;
  while (n < src.length && /[A-Za-z0-9_.:\-]/.test(src[n])) n++;
  const tagName = src.slice(i + 1, n);
  if (!tagName) return -1;

  // Scan to the closing `>` or `/>`, skipping over attribute strings and
  // `{...}` expression containers.
  let braceDepth = 0;
  let attrStr: '"' | "'" | null = null;
  let k = n;
  while (k < src.length) {
    const c = src[k];
    const c2 = src[k + 1];
    if (attrStr) {
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === attrStr) attrStr = null;
      k++;
      continue;
    }
    if (c === '"' || c === "'") {
      attrStr = c as '"' | "'";
      k++;
      continue;
    }
    if (c === "{") {
      braceDepth++;
      k++;
      continue;
    }
    if (c === "}") {
      if (braceDepth > 0) braceDepth--;
      k++;
      continue;
    }
    if (braceDepth === 0) {
      if (c === "/" && c2 === ">") {
        // Self-closing — don't push.
        return k + 2;
      }
      if (c === ">") {
        stack.push({ jsx: tagName });
        return k + 1;
      }
    }
    k++;
  }
  return -1;
}
