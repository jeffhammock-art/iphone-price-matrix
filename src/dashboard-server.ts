  // Minimal dev server for the dashboard.
//   npm run dashboard:serve   → http://localhost:8787
// /api/rebuild recompiles the embedded dashboard from the latest clean CSVs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dataDir = join(root, "data");

function sendText(res: any, status: number, body: string, type = "text/html"): void {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname === "/api/rebuild") {
    if (req.method !== "POST") {
      sendText(res, 405, "POST only", "application/json");
      return;
    }
    try {
      // Use shell:true so npx (a shell shim) resolves via PATH
      const result = spawnSync("npx", ["tsx", "src/dashboard.ts"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: true, // npx is a shell shim, not a direct executable
      });
      if (result.status !== 0) {
        const stderr = (result.stderr && result.stderr.toString()) || "";
        const stdout = (result.stdout && result.stdout.toString()) || "";
        throw new Error(`tsx exited ${result.status}\n${stdout}\n${stderr}`);
      }
      const html = await readFile(join(dataDir, "iphone-dashboard.html"), "utf8");
      const count = (html.match(/"model":"/g) || []).length;
      sendText(res, 200, JSON.stringify({ ok: true, message: "Rebuilt", records: count }), "application/json");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      sendText(res, 500, JSON.stringify({ ok: false, error: `Rebuild failed: ${detail}` }), "application/json");
    }
    return;
  }

  try {
    if (url.pathname === "/" || url.pathname === "/iphone-dashboard.html") {
      const html = await readFile(join(dataDir, "iphone-dashboard.html"), "utf8");
      sendText(res, 200, html, "text/html");
      return;
    }
    if (url.pathname === "/dashboard.app.js") {
      const js = await readFile(join(root, "src", "dashboard.app.js"), "utf8");
      sendText(res, 200, js, "application/javascript");
      return;
    }
  } catch {
    sendText(res, 404, "Not found");
    return;
  }

  sendText(res, 404, "Not found");
});

const port = 8787;
server.listen(port, () => {
  console.log(`Dashboard server: http://localhost:${port}`);
  console.log("Run 'npm run dashboard' to rebuild data without the server.");
});
