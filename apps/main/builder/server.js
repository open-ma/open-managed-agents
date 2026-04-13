// Minimal HTTP server for the DinD builder container.
// POST /build — receives build config, runs docker build + push.
// GET  /health — returns ok.

const http = require("http");
const { execSync, exec } = require("child_process");

function run(cmd, opts = {}) {
  const timeout = opts.timeout || 600000;
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ success: !err, stdout: stdout || "", stderr: stderr || "", exitCode: err?.code || 0 });
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok" }));
  }

  if (req.method === "POST" && req.url === "/build") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let params;
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid json" }));
    }

    const { dockerfile, image_tag, cf_api_token, cf_account_id, repo_url, env_id, kv_id } = params;
    if (!dockerfile || !image_tag || !cf_api_token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "missing required fields" }));
    }

    const workDir = `/tmp/build-${env_id || "default"}`;
    const steps = [];

    try {
      // 1. Write Dockerfile
      await run(`mkdir -p ${workDir}`);
      require("fs").writeFileSync(`${workDir}/Dockerfile`, dockerfile);
      steps.push("dockerfile_written");

      // 2. Docker build
      const build = await run(`docker build --network=host -t ${image_tag} ${workDir} 2>&1`);
      steps.push(`docker_build: ${build.success ? "ok" : "failed"}`);
      if (!build.success) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: `Docker build failed: ${build.stderr || build.stdout}`, steps }));
      }

      // 3. Registry login + push
      const login = await run(
        `CLOUDFLARE_API_TOKEN="${cf_api_token}" npx wrangler containers registries credentials --push 2>/dev/null | ` +
        `docker login --username _json_key --password-stdin registry.cloudflare.com 2>&1`,
        { timeout: 30000 }
      );
      steps.push(`registry_login: ${login.success ? "ok" : "failed"}`);

      const push = await run(`docker push ${image_tag} 2>&1`, { timeout: 300000 });
      steps.push(`docker_push: ${push.success ? "ok" : "failed"}`);
      if (!push.success) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: `Docker push failed: ${push.stderr || push.stdout}`, steps }));
      }

      // 4. Clone agent source + deploy
      if (repo_url && env_id) {
        const agentDir = `${workDir}/agent`;
        const clone = await run(`GIT_TEMPLATE_DIR= git clone --depth 1 ${repo_url} ${agentDir} 2>&1`, { timeout: 60000 });
        steps.push(`git_clone: ${clone.success ? "ok" : "failed"}`);
        if (!clone.success) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: `Git clone failed: ${clone.stderr || clone.stdout}`, steps }));
        }

        // Write wrangler config with custom image
        const wranglerConfig = JSON.stringify({
          name: `sandbox-${env_id}`,
          main: "index.ts",
          compatibility_date: "2025-04-01",
          compatibility_flags: ["nodejs_compat"],
          containers: [{ class_name: "Sandbox", image: image_tag, instance_type: "lite", max_instances: 10 }],
          durable_objects: { bindings: [
            { name: "SESSION_DO", class_name: "SessionDO" },
            { name: "SANDBOX", class_name: "Sandbox" },
          ]},
          kv_namespaces: [{ binding: "CONFIG_KV", id: kv_id || "" }],
          r2_buckets: [{ binding: "WORKSPACE_BUCKET", bucket_name: "managed-agents-workspace" }],
          migrations: [{ tag: "v1", new_sqlite_classes: ["SessionDO", "Sandbox"] }],
          limits: { cpu_ms: 300000 },
          observability: { enabled: true },
        }, null, 2);
        require("fs").writeFileSync(`${agentDir}/apps/agent/wrangler.jsonc`, wranglerConfig);

        const deploy = await run(
          `cd ${agentDir} && npm install --workspace=apps/agent --workspace=packages/shared 2>&1 && ` +
          `cd apps/agent && CLOUDFLARE_API_TOKEN="${cf_api_token}" CLOUDFLARE_ACCOUNT_ID="${cf_account_id}" ` +
          `npx wrangler deploy --config wrangler.jsonc 2>&1`,
          { timeout: 600000 }
        );
        steps.push(`wrangler_deploy: ${deploy.success ? "ok" : "failed"}`);
        if (!deploy.success) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: `Deploy failed: ${deploy.stderr || deploy.stdout}`, steps }));
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, sandbox_worker_name: `sandbox-${env_id}`, steps }));

    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message || String(err), steps }));
    }
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(8080, () => console.log("Builder server listening on :8080"));
