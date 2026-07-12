/**
 * A PERSISTENT clipboard worker — one process, held open, answering in milliseconds.
 *
 * ── The problem it exists to solve ────────────────────────────────────────
 * Every clipboard read used to spawn a fresh `powershell.exe`. A PowerShell cold
 * start is 200–500 ms, and it is paid EVERY time. `/paste` was worse than it
 * looks: it asked for files, then an image, then text — up to four spawns, one
 * after another, so a paste could take the better part of two seconds. The
 * auto-attach watcher was worse still: it noticed the clipboard change in one
 * process and then spawned two MORE to find out what was on it.
 *
 * That is not a clipboard being slow. That is us paying process-creation cost to
 * ask a question that takes the OS microseconds to answer.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 * Start ONE PowerShell, once, and keep it. It holds the Win32 clipboard APIs
 * already loaded and serves two roles at the same time:
 *
 *   • REQUEST/RESPONSE — Node writes `SNAPSHOT|<dest>` on stdin, the worker reads
 *     EVERYTHING the clipboard holds in a single pass (formats, files, text, and
 *     the image already decoded and saved to `<dest>`) and writes back one JSON
 *     line. A `/paste` is now one round-trip of a few milliseconds, not four
 *     process spawns.
 *
 *   • PUSH — the same loop polls `GetClipboardSequenceNumber()`, a free Win32
 *     counter that ticks on any clipboard write. When it moves AND an image is
 *     present, the worker saves the PNG ITSELF and pushes `IMAGE|<path>`. Node
 *     spawns nothing at all: a screenshot is attached ~150 ms after it is taken.
 *
 * Both roles share one process because `ReadLineAsync()` lets the loop check for
 * a pending command without blocking the poll — so we get request/response AND a
 * push channel without a second interpreter sitting in memory.
 *
 * The whole thing is best-effort. If PowerShell is missing, wedged, or refuses to
 * start, every method degrades to "no clipboard" and the operator loses a
 * convenience, never a turn.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Everything the clipboard holds, read in ONE pass. */
export interface ClipboardSnapshot {
	/** Absolute path to the PNG we saved, when the clipboard held an image. */
	imagePath?: string;
	/** Absolute paths of files copied in the file manager. */
	files: string[];
	/** Plain text, if any. */
	text: string;
	/** Format names, for telling the operator what IS there when a paste finds nothing. */
	formats: string[];
}

const EMPTY: ClipboardSnapshot = { files: [], text: "", formats: [] };

/**
 * The worker script.
 *
 * Every clipboard call is guarded: a clipboard can be LOCKED by another process
 * mid-read (Windows genuinely does this — an app holding it open makes
 * `GetImage()` throw), and a worker that dies on the first locked read is worse
 * than no worker.
 */
const WINDOWS_WORKER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BrigadeClip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
"@

function Emit([string]$msg) {
  # Write-Output goes through the pipeline and is block-buffered when stdout is a
  # pipe — so a worker that never exits would never flush a single line, and Node
  # would wait forever. Go straight to the console stream and flush by hand.
  [Console]::Out.WriteLine($msg)
  [Console]::Out.Flush()
}

function Save-ClipImage([string]$dest) {
  try {
    if (-not [Windows.Forms.Clipboard]::ContainsImage()) { return $null }
    $img = [Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $img) { return $null }
    $img.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    # CONFIRM it landed. Save() to a bad path raises a NON-terminating error, so
    # without this the worker would report a path to a file it never wrote, and the
    # attachment would fail later with no explanation of why.
    if (-not (Test-Path -LiteralPath $dest)) { return $null }
    return $dest
  } catch { return $null }
}

# [Console]::In is a SYNCHRONIZED TextReader, and its ReadLineAsync() is a lie: it
# calls ReadLine() on the calling thread and BLOCKS. With stdin an open pipe and no
# data yet, the worker blocked here forever and never announced itself — which the
# operator experienced as "the clipboard is slow". A StreamReader over the raw
# stdin handle is genuinely async.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$last = [BrigadeClip]::GetClipboardSequenceNumber()

# Announce readiness only after the assemblies are loaded and the C# above has
# compiled (1-2s). A request written before that is one the worker is not yet
# listening for.
Emit 'READY'

while ($true) {
  # 1. Serve a request, if one has arrived. Async so the poll below never blocks.
  if ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { break }          # stdin closed: parent is gone
    $pending = $stdin.ReadLineAsync()
    $parts = $line -split '\|', 3
    if ($parts[0] -eq 'EXIT') { break }
    if ($parts[0] -eq 'SNAPSHOT') {
      # Every reply carries the request's id. Without it, a slow reply lands on
      # whoever asked NEXT and hands them somebody else's clipboard.
      $id = $parts[1]
      $dest = $parts[2]
      $files = @()
      $text = ''
      $formats = @()
      try { $d = [Windows.Forms.Clipboard]::GetDataObject(); if ($d) { $formats = @($d.GetFormats()) } } catch {}
      try { if ([Windows.Forms.Clipboard]::ContainsFileDropList()) { $files = @([Windows.Forms.Clipboard]::GetFileDropList()) } } catch {}
      try { if ([Windows.Forms.Clipboard]::ContainsText()) { $text = [Windows.Forms.Clipboard]::GetText() } } catch {}
      $img = Save-ClipImage $dest
      $o = [ordered]@{ imagePath = $img; files = $files; text = $text; formats = $formats }
      Emit ('SNAPSHOT ' + $id + ' ' + ($o | ConvertTo-Json -Compress -Depth 3))
      # A snapshot READS the clipboard; don't let it look like a change and re-push.
      $last = [BrigadeClip]::GetClipboardSequenceNumber()
    }
  }

  # 2. Push an image the moment one lands. The sequence number is free to read, so
  #    the steady-state cost of this loop is an integer compare.
  $n = [BrigadeClip]::GetClipboardSequenceNumber()
  if ($n -ne $last) {
    $last = $n
    try {
      if ([Windows.Forms.Clipboard]::ContainsImage()) {
        $p = Join-Path $env:TEMP ("brigade-clip-" + $n + ".png")
        $saved = Save-ClipImage $p
        if ($saved) { Emit ('IMAGE ' + $saved) }
      }
    } catch {}
  }

  Start-Sleep -Milliseconds 150
}
`.trim();

export class ClipboardWorker {
	private child: ChildProcess | undefined;
	private buf = "";
	/** id → resolver. Keyed, because a slow reply must never land on the next caller. */
	private inflight = new Map<number, (s: ClipboardSnapshot) => void>();
	private nextId = 1;
	private onImage: ((imagePath: string) => void) | undefined;
	private dead = false;
	/** Whatever the worker last printed on stderr — the reason it is not answering. */
	lastError = "";
	/**
	 * Resolves when the worker has finished loading assemblies and compiling its
	 * P/Invoke shim (1-2 s) and has actually started reading stdin.
	 *
	 * Every request waits on this. A request written before the worker is listening
	 * is not merely slow — it times out, and its reply then arrives while the NEXT
	 * caller is waiting, handing them a stale answer. That is a correctness bug, and
	 * it is what a benchmark caught before an operator did.
	 */
	private ready: Promise<boolean> = Promise.resolve(false);
	private markReady: (ok: boolean) => void = () => {};

	/**
	 * True when a worker process exists. NOT the same as "ready" — callers await
	 * `snapshot`, which gates on readiness itself.
	 */
	get available(): boolean {
		return !this.dead && this.child !== undefined;
	}

	/**
	 * Start the worker. `onImage` is pushed a path whenever an image lands on the
	 * clipboard — that is the auto-attach channel, and it costs Node nothing.
	 */
	start(onImage?: (imagePath: string) => void): void {
		if (process.platform !== "win32" || this.child) return;
		this.onImage = onImage;
		// Build the readiness promise with LOCALS. Referring to `this.ready` inside its
		// own executor reads the PREVIOUS promise — which cleared the boot timer the
		// instant it was set, so readiness could never resolve and every snapshot
		// awaited forever. It hung for five minutes before this was caught.
		let settle: (ok: boolean) => void = () => {};
		const readyPromise = new Promise<boolean>((resolve) => {
			settle = resolve;
		});
		// Boot is 1-2 s (assembly load + C# compile). If it hasn't announced itself in
		// 15 s it never will — give up rather than making every paste wait forever.
		const bootTimer = setTimeout(() => settle(false), 15_000);
		void readyPromise.then(() => clearTimeout(bootTimer));
		this.ready = readyPromise;
		this.markReady = settle;

		try {
			// Run from a FILE, not `-Command`.
			//
			// The script contains a C# here-string (`@"…"@`) and therefore double quotes.
			// Passing that through `-Command` means it survives Node's argv quoting, then
			// CreateProcess's, then PowerShell's own parser — and it does not: the worker
			// died silently on a parse error and never announced itself, which read
			// exactly like "the clipboard is slow". A file has no quoting layer at all.
			const scriptPath = path.join(os.tmpdir(), "brigade-clipboard-worker.ps1");
			fs.writeFileSync(scriptPath, WINDOWS_WORKER, "utf8");
			this.child = spawn(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-STA",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					scriptPath,
				],
				{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
			);
			// A worker that by design never exits must never be the reason the process
			// stays alive. This hung the whole test suite once.
			this.child.unref();
		} catch {
			this.dead = true;
			this.markReady(false);
			return;
		}

		// stderr is captured, not discarded: a worker that fails to parse says WHY here,
		// and throwing that away is how a parse error masquerades as slowness.
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.lastError = chunk.toString("utf8").trim().slice(0, 400);
		});

		this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
		this.child.on("error", () => this.kill());
		this.child.on("exit", () => {
			// Settle everyone waiting, or a /paste hangs forever on a dead worker.
			for (const resolve of this.inflight.values()) resolve(EMPTY);
			this.inflight.clear();
			this.markReady(false);
			this.child = undefined;
		});
	}

	private consume(text: string): void {
		this.buf += text;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			if (line === "READY") {
				this.markReady(true);
				continue;
			}
			if (line.startsWith("IMAGE ")) {
				this.onImage?.(line.slice("IMAGE ".length).trim());
				continue;
			}
			if (line.startsWith("SNAPSHOT ")) {
				const rest = line.slice("SNAPSHOT ".length);
				const sp = rest.indexOf(" ");
				if (sp < 0) continue;
				const id = Number.parseInt(rest.slice(0, sp), 10);
				const resolve = this.inflight.get(id);
				this.inflight.delete(id);
				if (!resolve) continue; // a reply to a request that already timed out
				try {
					const raw = JSON.parse(rest.slice(sp + 1)) as {
						imagePath?: string | null;
						files?: string[] | string | null;
						text?: string | null;
						formats?: string[] | string | null;
					};
					// PowerShell's ConvertTo-Json collapses a one-element array to a bare
					// scalar. Normalising here is not pedantry: without it, a single copied
					// file arrives as a string and `files.map` throws.
					const arr = (v: string[] | string | null | undefined): string[] =>
						Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
					resolve({
						...(raw.imagePath ? { imagePath: raw.imagePath } : {}),
						files: arr(raw.files),
						text: typeof raw.text === "string" ? raw.text : "",
						formats: arr(raw.formats),
					});
				} catch {
					resolve(EMPTY);
				}
			}
		}
	}

	/**
	 * Read the ENTIRE clipboard in one round-trip, saving any image to `imageDest`.
	 *
	 * One call, one answer. The old shape asked four separate questions down four
	 * separate PowerShell spawns — which is why a paste felt like it hung.
	 */
	async snapshot(imageDest: string, timeoutMs = 5000): Promise<ClipboardSnapshot> {
		// Wait for boot. Skipping this is what made the first paste of a session time
		// out, and then handed its late reply to whoever asked next.
		if (!(await this.ready)) return EMPTY;
		if (!this.child?.stdin) return EMPTY;

		const id = this.nextId++;
		return await new Promise<ClipboardSnapshot>((resolve) => {
			const timer = setTimeout(() => {
				this.inflight.delete(id);
				resolve(EMPTY);
			}, timeoutMs);
			this.inflight.set(id, (s) => {
				clearTimeout(timer);
				resolve(s);
			});
			try {
				this.child?.stdin?.write(`SNAPSHOT|${id}|${imageDest}\n`);
			} catch {
				clearTimeout(timer);
				this.inflight.delete(id);
				resolve(EMPTY);
			}
		});
	}

	kill(): void {
		this.dead = true;
		this.markReady(false);
		for (const resolve of this.inflight.values()) resolve(EMPTY);
		this.inflight.clear();
		try {
			this.child?.stdin?.write("EXIT\n");
			this.child?.kill();
		} catch {
			/* already gone */
		}
		this.child = undefined;
	}
}
