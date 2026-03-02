import { execSync } from "node:child_process";
import process from "node:process";

const rawPort = process.argv[2] ?? "3001";
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[dev] Invalid port: ${rawPort}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command) {
  try {
    return execSync(command, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function uniqueInts(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const parsed = Number.parseInt(String(value).trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      continue;
    }
    if (parsed === process.pid || seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

function getListeningPids(targetPort) {
  if (process.platform === "win32") {
    const output = run(
      `powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); if($p){$p | Sort-Object -Unique | ForEach-Object { Write-Output $_ }}"`,
    );
    return uniqueInts(output.split(/\r?\n/g));
  }

  const output = run(`lsof -ti tcp:${targetPort}`);
  return uniqueInts(output.split(/\r?\n/g));
}

function killPid(pid) {
  if (process.platform === "win32") {
    run(`taskkill /PID ${pid} /T /F`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore missing/permission errors; final check below handles failures.
  }
}

async function ensurePortFree(targetPort) {
  let pids = getListeningPids(targetPort);
  if (pids.length === 0) {
    return;
  }

  console.log(`[dev] Port ${targetPort} is busy. Stopping process(es): ${pids.join(", ")}`);
  for (const pid of pids) {
    killPid(pid);
  }

  await sleep(700);
  pids = getListeningPids(targetPort);
  if (pids.length === 0) {
    return;
  }

  if (process.platform !== "win32") {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore and verify after.
      }
    }
    await sleep(500);
    pids = getListeningPids(targetPort);
  }

  if (pids.length > 0) {
    console.error(
      `[dev] Port ${targetPort} is still in use by PID(s): ${pids.join(", ")}. ` +
        "Close them manually, then retry.",
    );
    process.exit(1);
  }
}

await ensurePortFree(port);
