import { loadConfig } from "../src/config.js";
import assert from "node:assert";

// config defaults
const c = loadConfig({});
assert.equal(c.adbPath, "adb", "adbPath default");
assert.equal(c.adbPort, 0, "adbPort default 0");
assert.equal(c.adbMode, "auto", "adbMode default");
assert.equal(c.taskerDir, "/sdcard/Tasker", "taskerDir default");
assert.equal(c.taskerReloadAction, "net.dinglisch.android.tasker.RELOAD_VARIABLES", "reload action default");
assert.equal(c.rclonePath, "rclone", "rclonePath default");
assert.equal(c.maxOutputBytes, 48 * 1024, "maxOutputBytes default");
assert.equal(c.adbMaxRetries, 2, "adbMaxRetries default");

// config overrides from env
const c2 = loadConfig({
  SYLVIA_ADB_PORT: "5555",
  SYLVIA_ADB_MODE: "emulator",
  SYLVIA_TASKER_RELOAD_ACTION: "custom.ACTION",
  SYLVIA_ADB_MAX_RETRIES: "5",
  SYLVIA_MAX_OUTPUT_BYTES: "1024"
});
assert.equal(c2.adbPort, 5555, "adbPort override");
assert.equal(c2.adbMode, "emulator", "adbMode override");
assert.equal(c2.taskerReloadAction, "custom.ACTION", "reload action override");
assert.equal(c2.adbMaxRetries, 5, "retries override");
assert.equal(c2.maxOutputBytes, 1024, "maxOutputBytes override");

console.log("config: OK (defaults + overrides)");
