const FENCE_OPEN = /```(?:jsx|tsx|javascript|js|typescript|ts|react)?\s*\n/i;

export function extractJsx(text: string): string | null {
  if (!text) return null;

  const openMatch = text.match(FENCE_OPEN);
  if (!openMatch || openMatch.index === undefined) return null;

  const start = openMatch.index + openMatch[0].length;
  const rest = text.slice(start);

  const closeIdx = rest.indexOf("```");
  const body = closeIdx === -1 ? rest : rest.slice(0, closeIdx);

  const trimmed = body.trimEnd();
  if (trimmed.length === 0) return null;

  return sanitizeCode(trimmed);
}

const REACT_EXPORTS = new Set([
  "useState",
  "useEffect",
  "useMemo",
  "useCallback",
  "useRef",
  "useReducer",
  "useContext",
  "useLayoutEffect",
  "useImperativeHandle",
  "useDebugValue",
  "useId",
  "useTransition",
  "useDeferredValue",
  "useSyncExternalStore",
  "useInsertionEffect",
  "Fragment",
  "createContext",
  "createElement",
  "forwardRef",
  "memo",
  "lazy",
  "Suspense",
  "Children",
  "cloneElement",
  "isValidElement",
  "startTransition",
]);

const ALLOWED_PACKAGES = new Set(["react", "react-dom", "lucide-react"]);

function sanitizeCode(code: string): string {
  let out = code;

  out = out.replace(
    /import\s+React\s*(?:,\s*\{([^}]*)\})?\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_m, hooks: string | undefined, _pkg: string) => {
      const hookPart = hooks ? `, { ${hooks.trim()} }` : "";
      return `import React${hookPart} from "react";`;
    }
  );

  out = out.replace(
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (match, names: string, pkg: string) => {
      if (ALLOWED_PACKAGES.has(pkg)) return match;

      const items = names
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const localNames = items.map((i) => i.split(/\s+as\s+/)[0].trim());

      if (localNames.every((n) => REACT_EXPORTS.has(n))) {
        return `import { ${items.join(", ")} } from "react";`;
      }

      return "";
    }
  );

  return out;
}
