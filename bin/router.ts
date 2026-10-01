#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createProxyServer, reportStartupProblems } from "../src/server.js";
import { isMainModule } from "../src/isMainModule.js";
import { reportMain } from "./report.js";

const USAGE = `typesafe-claude-router - cache-aware model tier router for Claude Code

  typesafe-claude-router serve            start the proxy (PORT, HOST, ROUTER_MODE)
  typesafe-claude-router run -- claude    start the proxy, run a command against it, tear down
  typesafe-claude-router report [path]    summarize a ledger
`;

async function listenOnEphemeralPort() {
  const server = createProxyServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return { server, port };
}

// The whole setup dance - start the proxy, point ANTHROPIC_BASE_URL at
// it, run the client, shut down - in one command, so trying the router
// costs one line instead of two terminals and three env vars.
export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error(USAGE);
    return 1;
  }
  const { server, port } = await listenOnEphemeralPort();
  const child = spawn(argv[0], argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
  });
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode ?? 0));
    child.on("error", () => resolve(1));
  });
  // Drop keep-alive sockets too, or close() waits on them and the wrapper
  // hangs after the client has already exited.
  server.closeAllConnections();
  server.close();
  return code;
}

if (isMainModule(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "report") {
    reportMain(rest);
  } else if (command === "run") {
    if (reportStartupProblems(process.env)) process.exit(1);
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    run(args).then((code) => process.exit(code));
  } else if (command === "serve" || command === undefined) {
    if (reportStartupProblems(process.env)) process.exit(1);
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? "127.0.0.1";
    createProxyServer().listen(port, host, () => {
      const mode = process.env.ROUTER_MODE === "live" ? "live" : "shadow";
      console.log(`typesafe-claude-router listening on http://${host}:${port} (mode=${mode})`);
    });
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
