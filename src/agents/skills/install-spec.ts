/**
 * `SkillInstallSpec` — the structured shape behind the `skills.install` RPC
 * for installer-managed skill setup. Mirrors the reference codebase's
 * spec; Brigade implements the universal install kinds (no ClawHub remote
 * registry yet, so `clawhub` source is intentionally absent).
 *
 * Each `kind` has its own required fields; the union is kept narrow so a
 * misshapen request fails validation at the boundary rather than mid-shell.
 *
 *   - `brew`     → `brew install <formula>`   (macOS / Linuxbrew only)
 *   - `node`     → `npm install -g <package>` (system node)
 *   - `go`       → `go install <module>`      (system go toolchain)
 *   - `uv`       → `uv pip install <package>` (system uv)
 *   - `download` → fetch `url` to `targetDir`/<basename>
 *
 * The shape is intentionally permissive (every package-shape field optional)
 * so a single TS type can describe any installer; the install runner
 * (`install.ts`) validates per-kind before invoking the underlying tool.
 */

export type SkillInstallSpecKind = "brew" | "node" | "go" | "uv" | "download";

export interface SkillInstallSpec {
	/** Discriminator — selects the installer command shape below. */
	kind: SkillInstallSpecKind;
	/**
	 * Generic per-kind target. `brew` reads `formula`, `node` reads
	 * `package`, `go` reads `module`, `uv` reads `package`, `download`
	 * reads `url`. `target` is a friendly alias the caller can supply
	 * instead — when set, the install runner copies it into the per-kind
	 * field if that field is missing.
	 */
	target?: string;
	/** Cosmetic id for the option (so `skills.status` can refer to it). */
	id?: string;
	/** Human-readable label (for status/install UIs). */
	label?: string;
	/** Bins this install is expected to make available afterwards. */
	bins?: string[];
	/** OS allowlist (`process.platform` values). Empty/absent → all OSes. */
	os?: string[];

	/* Per-kind fields. Only the field matching `kind` is read. */
	/** brew formula name (e.g. `gh`). */
	formula?: string;
	/** npm package name for `kind === "node"` (e.g. `cowsay`). */
	package?: string;
	/** go module path for `kind === "go"` (e.g. `github.com/x/y@latest`). */
	module?: string;
	/** Source URL for `kind === "download"`. */
	url?: string;
	/** Destination directory for `kind === "download"`. Created if missing. */
	targetDir?: string;
}
