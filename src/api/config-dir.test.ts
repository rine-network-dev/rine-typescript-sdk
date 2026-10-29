import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { SDKHttpClient } from "./http.js";

/**
 * Regression coverage for the config-dir precedence bug: a no-arg client used
 * to hard-code `configDir = ""` in the constructor, ignoring RINE_CONFIG_DIR
 * and the documented precedence. It must now lazily fall back to rine-core's
 * `resolveConfigDir()` at principal-load time (Python-SDK parity).
 */

const ENV_KEY = "RINE_CONFIG_DIR";
const API_ENV_KEY = "RINE_API_URL";
const OWNER_ENV_KEY = "RINE_OWNER_DIR";
/** rine-core's DEFAULT_API_URL — the correct no-env fallback. */
const DEFAULT_API_URL = "https://rine.network";

let tmpConfig: string;
let prevEnv: string | undefined;
let prevApiEnv: string | undefined;
let prevOwnerEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[ENV_KEY];
  prevApiEnv = process.env[API_ENV_KEY];
  prevOwnerEnv = process.env[OWNER_ENV_KEY];
  tmpConfig = fs.mkdtempSync(join(tmpdir(), "rine-sdk-configdir-"));
  fs.writeFileSync(
    join(tmpConfig, "profiles.json"),
    JSON.stringify({
      default: {
        org_id: "00000000-0000-4000-8000-000000000000",
        principal: "org:00000000-0000-4000-8000-000000000000",
      },
    }),
  );
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  if (prevApiEnv === undefined) delete process.env[API_ENV_KEY];
  else process.env[API_ENV_KEY] = prevApiEnv;
  if (prevOwnerEnv === undefined) delete process.env[OWNER_ENV_KEY];
  else process.env[OWNER_ENV_KEY] = prevOwnerEnv;
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

describe("SDKHttpClient config-dir resolution", () => {
  it("honors RINE_CONFIG_DIR when no configDir is passed", () => {
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient();
    expect(client.configDir).toBe(tmpConfig);
  });

  it("prefers an explicit configDir over RINE_CONFIG_DIR", () => {
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient({ configDir: "/explicit/dir" });
    expect(client.configDir).toBe("/explicit/dir");
  });

  it("uses an explicit empty-string configDir verbatim (no auto-resolution)", () => {
    // An explicitly-passed "" is a caller choice and must be honored as-is,
    // distinct from the "no argument" case that triggers auto-resolution.
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient({ configDir: "" });
    expect(client.configDir).toBe("");
  });

  it("memoizes the resolved dir across repeated reads", () => {
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient();
    const first = client.configDir;
    // Mutating the env after the first resolution must not change the answer —
    // resolution happens once, matching the Python SDK's construct-time resolve.
    process.env[ENV_KEY] = "/changed/after/resolve";
    expect(client.configDir).toBe(first);
  });

  it("throws the upgrade error when discovery finds only the retired sign-in file", () => {
    // A dir holding the retired credentials.json and no profiles.json is a
    // pre-org-root account: discovery must stop with the upgrade text rather
    // than silently skipping the dir.
    const retired = fs.mkdtempSync(join(tmpdir(), "rine-sdk-retired-"));
    try {
      fs.writeFileSync(
        join(retired, "credentials.json"),
        JSON.stringify({ default: { client_id: "id", client_secret: "sec" } }),
      );
      process.env[ENV_KEY] = retired;
      const client = new SDKHttpClient();
      expect(() => client.configDir).toThrow(
        /^This rine account uses the retired client_secret sign-in/,
      );
    } finally {
      fs.rmSync(retired, { recursive: true, force: true });
    }
  });
});

describe("SDKHttpClient owner-dir resolution", () => {
  it("honors RINE_OWNER_DIR in the ownerDir getter", () => {
    process.env[OWNER_ENV_KEY] = "/env/owner/dir";
    const client = new SDKHttpClient({ configDir: tmpConfig });
    expect(client.ownerDir).toBe("/env/owner/dir");
  });

  it("prefers an explicit ownerDir over RINE_OWNER_DIR", () => {
    process.env[OWNER_ENV_KEY] = "/env/owner/dir";
    const client = new SDKHttpClient({
      configDir: tmpConfig,
      ownerDir: "/explicit/owner",
    });
    expect(client.ownerDir).toBe("/explicit/owner");
  });
});

describe("SDKHttpClient agent-only mode", () => {
  it("rejects an explicit ownerDir together with agentOnly", () => {
    expect(
      () => new SDKHttpClient({ configDir: tmpConfig, ownerDir: "/o", agentOnly: true }),
    ).toThrow(ConfigError);
  });

  it("ignores RINE_OWNER_DIR and exposes no owner dir", () => {
    process.env[OWNER_ENV_KEY] = "/env/owner/dir";
    const client = new SDKHttpClient({ configDir: tmpConfig, agentOnly: true });
    expect(client.ownerDir).toBeUndefined();
    expect(client.dirs).toEqual({ configDir: tmpConfig, agentOnly: true });
  });

  it("refuses owner-side operations", () => {
    const client = new SDKHttpClient({ configDir: tmpConfig, agentOnly: true });
    expect(() => client.custodyDirs()).toThrow(ConfigError);
  });
});

describe("SDKHttpClient apiUrl resolution", () => {
  it("resolves apiUrl from RINE_API_URL when none is passed", () => {
    process.env[API_ENV_KEY] = "http://localhost:7001";
    const client = new SDKHttpClient();
    expect(client.apiUrl).toBe("http://localhost:7001");
  });

  it("falls back to core DEFAULT_API_URL (rine.network), not api.rine.network", () => {
    delete process.env[API_ENV_KEY];
    const client = new SDKHttpClient();
    expect(client.apiUrl).toBe(DEFAULT_API_URL);
    expect(client.apiUrl).not.toContain("api.rine.network");
  });

  it("prefers an explicit apiUrl over RINE_API_URL", () => {
    process.env[API_ENV_KEY] = "http://localhost:7001";
    const client = new SDKHttpClient({ apiUrl: "https://explicit.example" });
    expect(client.apiUrl).toBe("https://explicit.example");
  });
});
