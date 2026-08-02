import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const [port, dataDirArg, stdoutPath, stderrPath, root] = process.argv.slice(2);
const dataDir = dataDirArg === "-" ? "" : dataDirArg;
if (!port || !stdoutPath || !stderrPath || !root) {
  throw new Error("usage: online-launch.mjs PORT DATA_DIR STDOUT STDERR ROOT");
}

const stdout = openSync(stdoutPath, "a");
const stderr = openSync(stderrPath, "a");
const env = { ...process.env, ONLINE_PORT: port };
if (dataDir) env.ONLINE_DATA_DIR = dataDir;
else delete env.ONLINE_DATA_DIR;

const child = spawn(process.execPath, [path.join(root, "server", "online.mjs")], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", stdout, stderr],
  env,
});
child.unref();
closeSync(stdout);
closeSync(stderr);
process.stdout.write(JSON.stringify({ pid: child.pid }));
