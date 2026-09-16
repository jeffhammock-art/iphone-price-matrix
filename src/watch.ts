import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeartbeat } from "./heartbeat.js";
import { backoffMs, classifyText, deathsInWindow, extractWantedPath, rememberSignature } from "./heal.js";
import { killProcessTree, releaseChromeProfile } from "./chrome-profile.js";
import { modelPaths } from "./store.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");
const STALL_MS = 6 * 60 * 1000;
const MAX_DEATHS_PER_HOUR = 5;

async function coverageTail(modelId: string, lines = 40): Promise<string> {
  try {
    const raw = await readFile(modelPaths(dataDir, modelId).coverage, "utf8");
    return raw.trim().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function writeIncident(body: string): Promise<void> {
  const dir = join(dataDir, "incidents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.md"), body, "utf8");
}

async function runChild(args: string[]): Promise<{ code: number | null; stalled: boolean }> {
  await releaseChromeProfile();
  const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "src/cli.ts", ...args], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });

  let stalled = false;
  const timer = setInterval(async () => {
    const beat = await readHeartbeat(dataDir);
    if (!beat) return;
    const age = Date.now() - Date.parse(beat.ts);
    if (age > STALL_MS && child.pid && child.exitCode === null) {
      stalled = true;
      killProcessTree(child.pid);
    }
  }, 15_000);

  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  clearInterval(timer);
  return { code, stalled };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: "string", default: "iphone-15" },
      all: { type: "boolean", default: false },
      delay: { type: "string" },
    },
  });

  await mkdir(dataDir, { recursive: true });
  const modelId = values.all ? "all" : (values.model ?? "iphone-15");
  const crawlArgs = ["crawl"];
  if (values.all) crawlArgs.push("--all");
  else crawlArgs.push("--model", values.model ?? "iphone-15");
  if (values.delay) crawlArgs.push("--delay", values.delay);

  console.log(`Supervisor starting: ${crawlArgs.join(" ")}`);

  while (true) {
    const startedAt = Date.now();
    const { code, stalled } = await runChild(crawlArgs);
    const tail = await coverageTail(values.all ? "iphone-15" : (values.model ?? "iphone-15"));
    const finishMatch = [...tail.matchAll(/\[([^\]]+)\] Finished crawl for /g)].pop();
    const finishedThisRun =
      !stalled &&
      code === 0 &&
      Boolean(finishMatch?.[1]) &&
      Date.parse(finishMatch?.[1] ?? "") >= startedAt - 5_000 &&
      !/Aborted after 3 passes|browser has been closed/.test(tail.slice(-800));
    if (finishedThisRun) {
      console.log("Supervisor: crawl finished cleanly.");
      return;
    }

    const blob = `${stalled ? "heartbeat_stall\n" : ""}${tail}\nexit ${code}`;
    const signature = classifyText(blob);
    const path = extractWantedPath(tail.split(/\r?\n/).reverse().find((line) => line.includes("wanted ")) ?? "");
    const state = await rememberSignature(dataDir, signature, {
      path: path ?? undefined,
      modelId,
      death: true,
    });
    const deaths = deathsInWindow(state, modelId);
    console.log(`Supervisor: child ended code=${code} stalled=${stalled} signature=${signature} deaths=${deaths}`);

    if (deaths >= MAX_DEATHS_PER_HOUR) {
      const incident = `# Circuit breaker

- model: ${modelId}
- signature: ${signature}
- deaths this hour: ${deaths}
- playbook: ${state.signatures[signature]?.playbook ?? "none"}
- exit: ${code} stalled=${stalled}

## Coverage tail

\`\`\`
${tail}
\`\`\`
`;
      await writeIncident(incident);
      console.error("Supervisor: circuit breaker. See data/incidents/latest.md");
      process.exitCode = 1;
      return;
    }

    const wait = backoffMs(deaths);
    console.log(`Supervisor: playbook ${state.signatures[signature]?.playbook}; retry in ${wait}ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
