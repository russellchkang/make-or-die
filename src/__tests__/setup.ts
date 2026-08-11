/**
 * Global test setup — sandbox the filesystem.
 *
 * Every path in the runtime hangs off the automaton home directory (see
 * src/paths.ts). Unless that is redirected, any test that touches the
 * default location writes into the real user profile: test runs were
 * leaving ~/.automaton/workspace/<ulid>/ behind on developer machines.
 *
 * Individual tests redirecting AUTOMATON_HOME themselves is not enough --
 * it only takes one new test that forgets. Pointing the whole run at a
 * temp directory makes the leak structurally impossible, and any test that
 * still wants its own home can override AUTOMATON_HOME locally.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

let testHome: string;

beforeAll(() => {
  testHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "automaton-test-home-")),
  );
  process.env.AUTOMATON_HOME = testHome;
  // HOME is consulted before os.homedir(); set it too so any code path that
  // reads it directly stays inside the sandbox.
  process.env.HOME = testHome;
});

afterAll(() => {
  try {
    if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  } catch {
    // Best effort — a leftover temp directory is harmless.
  }
});
