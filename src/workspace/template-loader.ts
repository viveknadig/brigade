import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Lazy resolver + content cache for the persona-template directory shipped
// alongside brigade. Templates live as plain markdown on disk so users (and
// future tooling) can edit them without touching compiled code.
//
// Resolution order:
//   1. <brigade-package-root>/templates/workspace/    — wins on installed copies
//   2. <cwd>/templates/workspace/                     — wins when running from a clone
//   3. baked fallback relative to this compiled module — safety net
//
// `cachedTemplateDir` short-circuits every subsequent call after the first
// successful probe. `resolvingTemplateDir` ensures concurrent callers share
// a single fs probe rather than racing.

const FALLBACK_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/workspace",
);

let cachedTemplateDir: string | undefined;
let resolvingTemplateDir: Promise<string> | undefined;

// Per-template promise cache. Keyed by filename so concurrent loads of the
// same template share one fs hit. We cache the *promise* (not the resolved
// value) so an in-flight read is awaited rather than restarted.
const templateContentCache = new Map<string, Promise<string>>();

export interface ResolveTemplateDirOptions {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}

export async function resolveWorkspaceTemplateDir(
  opts?: ResolveTemplateDirOptions,
): Promise<string> {
  if (cachedTemplateDir) return cachedTemplateDir;
  if (resolvingTemplateDir) return resolvingTemplateDir;

  resolvingTemplateDir = (async () => {
    const moduleUrl = opts?.moduleUrl ?? import.meta.url;
    const argv1 = opts?.argv1 ?? process.argv[1];
    const cwd = opts?.cwd ?? process.cwd();

    const packageRoot = await resolveBrigadePackageRoot({ moduleUrl, argv1, cwd });
    const candidates: string[] = [];
    if (packageRoot) candidates.push(path.join(packageRoot, "templates", "workspace"));
    if (cwd) candidates.push(path.resolve(cwd, "templates", "workspace"));
    candidates.push(FALLBACK_TEMPLATE_DIR);

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        cachedTemplateDir = candidate;
        return candidate;
      }
    }

    // No candidate resolved — first guess wins so error messages reference
    // the most plausible install location.
    cachedTemplateDir = candidates[0] ?? FALLBACK_TEMPLATE_DIR;
    return cachedTemplateDir;
  })();

  // Don't clear `resolvingTemplateDir` after the await — the `cachedTemplateDir`
  // short-circuit at the top of this function is what dedupes subsequent
  // callers, and clearing the in-flight promise here was misleading rather
  // than helpful (it suggested re-resolution after success, which would be
  // wrong).
  return resolvingTemplateDir;
}

export interface LoadedTemplate {
  name: string;
  content: string;
  source: string;
}

// Returns the template content with any leading YAML frontmatter stripped.
// Throws if the file is missing — callers that want soft-fail should use
// tryLoadWorkspaceTemplate. Frontmatter strip matches the reference loader's
// behavior so workspace seeding produces identical output bytes.
export async function loadWorkspaceTemplate(name: string): Promise<LoadedTemplate> {
  const existing = templateContentCache.get(name);
  if (existing) {
    const dir = await resolveWorkspaceTemplateDir();
    return { name, content: await existing, source: path.join(dir, name) };
  }

  const promise = (async () => {
    const dir = await resolveWorkspaceTemplateDir();
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    return stripFrontMatter(raw);
  })();

  templateContentCache.set(name, promise);

  try {
    const content = await promise;
    const dir = await resolveWorkspaceTemplateDir();
    return { name, content, source: path.join(dir, name) };
  } catch (err) {
    templateContentCache.delete(name);
    throw err;
  }
}

// Strips a leading YAML frontmatter block (`---\n…\n---\n`) from a markdown
// document. The frontmatter is metadata for tools that consume the source
// templates and is not meant to land in the rendered workspace files.
// Anything other than a frontmatter-starting `---` line at offset 0 is
// returned unchanged.
function stripFrontMatter(text: string): string {
  if (!text.startsWith("---")) return text;
  // Accept `---\n` or `---\r\n` as the opener.
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0) return text;
  const opener = text.slice(0, firstNewline).trim();
  if (opener !== "---") return text;

  // Find the closing `---` on its own line. Use a multiline-aware search
  // starting after the opener.
  const closingPattern = /\r?\n---\s*(\r?\n|$)/;
  const match = closingPattern.exec(text.slice(firstNewline));
  if (!match || match.index === undefined) return text;

  // Skip past the closing newline so the returned content starts cleanly.
  const closeStart = firstNewline + match.index + match[0].length;
  return text.slice(closeStart);
}

// Soft-fail variant: returns undefined when the template is missing or
// can't be read. Used by the onboard flow so a partially-customised
// templates dir doesn't break workspace seeding.
export async function tryLoadWorkspaceTemplate(
  name: string,
): Promise<LoadedTemplate | undefined> {
  try {
    return await loadWorkspaceTemplate(name);
  } catch {
    return undefined;
  }
}

export function resetWorkspaceTemplateCache(): void {
  cachedTemplateDir = undefined;
  resolvingTemplateDir = undefined;
  templateContentCache.clear();
}

// Walks upwards from the candidate dirs looking for a package.json whose
// `name` field equals "brigade". Bounded depth so a misconfigured cwd
// can't burn cycles.
//
// Tries four entry points:
//   1. dirname(moduleUrl) — wins when running from the installed package
//   2. realpath(argv1) — handles nvm/Homebrew/pnpm bin shims that symlink
//      `brigade` from a versioned cache; without realpath we'd walk up the
//      shim's directory, never reaching the package root
//   3. argv1 reconstructed from a `.bin/brigade` to `node_modules/brigade`
//   4. cwd — last-resort fallback for misconfigured installs
async function resolveBrigadePackageRoot(args: {
  moduleUrl: string;
  argv1?: string;
  cwd: string;
}): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(args.moduleUrl));
  const fromModule = await findPackageRoot(moduleDir);
  if (fromModule) return fromModule;

  if (args.argv1) {
    // Resolve symlinks first so nvm/Homebrew/pnpm bin shims point at the
    // real package location instead of a cache dir that has no package.json.
    const realArgv = await safeRealpath(args.argv1);
    const argvDir = path.dirname(realArgv ?? path.resolve(args.argv1));
    const fromArgv = await findPackageRoot(argvDir);
    if (fromArgv) return fromArgv;

    // npm/pnpm install-time symlinks land at <prefix>/node_modules/.bin/brigade
    // and the package itself lives at <prefix>/node_modules/brigade — try
    // that reconstruction explicitly so the walk doesn't have to traverse
    // through .bin/.
    const reconstructed = reconstructFromBinDir(realArgv ?? args.argv1);
    if (reconstructed) {
      const fromReconstructed = await findPackageRoot(reconstructed);
      if (fromReconstructed) return fromReconstructed;
    }
  }

  const fromCwd = await findPackageRoot(args.cwd);
  if (fromCwd) return fromCwd;

  return undefined;
}

async function safeRealpath(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(path.resolve(p));
  } catch {
    return undefined;
  }
}

// Given a path like `<prefix>/node_modules/.bin/brigade`, return
// `<prefix>/node_modules/brigade`. Returns undefined for paths that don't
// match the .bin/ shape.
function reconstructFromBinDir(argv1: string): string | undefined {
  const segments = path.resolve(argv1).split(path.sep);
  const binIdx = segments.lastIndexOf(".bin");
  if (binIdx < 1) return undefined;
  if (segments[binIdx - 1] !== "node_modules") return undefined;
  // Drop the trailing `.bin/<binname>` and append `brigade`.
  return path.join(...segments.slice(0, binIdx), "brigade");
}

async function findPackageRoot(start: string): Promise<string | undefined> {
  let cur = path.resolve(start);
  for (let depth = 0; depth < 10; depth++) {
    const pkgPath = path.join(cur, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as { name?: string };
      if (pkg.name === "brigade") return cur;
    } catch {
      // Not a package.json, or not parseable, or doesn't match — keep walking.
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
