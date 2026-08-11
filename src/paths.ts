/**
 * Home Directory Resolution
 *
 * Every path in the runtime hangs off the automaton's home directory. This
 * module is the single place that decides where that is.
 *
 * Resolution order, and why:
 *
 *   1. $AUTOMATON_HOME — explicit override, for tests and for running more
 *      than one automaton on a single host.
 *   2. $HOME — the sandbox sets this to /root, so production behaviour is
 *      unchanged. Honouring it first is also what lets a test redirect all
 *      filesystem writes into a temp directory.
 *   3. os.homedir() — the correct answer on a developer machine. Note that
 *      on Windows this reads USERPROFILE and ignores $HOME, which is why it
 *      must never be consulted before $HOME: doing so makes tests escape
 *      their temp directory and write into the real user profile.
 *   4. "/root" — the historical sandbox default, kept as a last resort.
 *
 * Previously call sites open-coded `process.env.HOME || "/root"`, which on
 * Windows produced the literal path C:\root, while one site used
 * os.homedir(), which ignored test redirection. Both leaked files outside
 * the intended directory.
 */

import os from "node:os";
import path from "node:path";

export const SANDBOX_DEFAULT_HOME = "/root";

/** Absolute path to the automaton's home directory. */
export function getHomeDir(): string {
  const override = process.env.AUTOMATON_HOME || process.env.HOME;
  if (override && override.trim()) return override;

  try {
    const home = os.homedir();
    if (home && home.trim()) return home;
  } catch {
    // os.homedir() can throw if the user database is unavailable.
  }

  return SANDBOX_DEFAULT_HOME;
}

/** Path inside the automaton's state directory (~/.automaton/...). */
export function getAutomatonHome(...segments: string[]): string {
  return path.join(getHomeDir(), ".automaton", ...segments);
}

/**
 * Expand a leading "~" against the automaton home directory.
 * Paths that do not start with "~" are returned unchanged.
 */
export function expandHome(filePath: string): string {
  if (filePath === "~") return getHomeDir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(getHomeDir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * True when `child` is `parent` or sits underneath it.
 *
 * Uses path.relative rather than string prefix matching so it is correct on
 * Windows (backslash separators) and immune to the classic "/root-evil"
 * prefix bypass.
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
