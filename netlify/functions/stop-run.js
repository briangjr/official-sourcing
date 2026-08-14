// netlify/functions/stop-run.js
//
// Two things, both requested: disables the workflow (no more scheduled or
// manual runs until resumed) AND cancels any run currently in progress or
// queued, so "stop" actually stops something happening right now too.

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, ADMIN_KEY } = process.env;

  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const baseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/source.yml`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  const results = { disabled: false, cancelledRuns: [], errors: [] };

  try {
    // 1. Cancel anything currently running or queued.
    for (const status of ["in_progress", "queued"]) {
      const runsRes = await fetch(`${baseUrl}/runs?status=${status}`, { headers });
      if (runsRes.ok) {
        const data = await runsRes.json();
        for (const run of data.workflow_runs || []) {
          const cancelRes = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${run.id}/cancel`,
            { method: "POST", headers }
          );
          if (cancelRes.ok || cancelRes.status === 202) {
            results.cancelledRuns.push(run.id);
          } else {
            results.errors.push(`Could not cancel run ${run.id}: ${cancelRes.status}`);
          }
        }
      }
    }

    // 2. Disable the workflow so nothing new starts (scheduled or manual).
    const disableRes = await fetch(`${baseUrl}/disable`, { method: "PUT", headers });
    results.disabled = disableRes.ok || disableRes.status === 204;
    if (!results.disabled) {
      results.errors.push(`Could not disable workflow: ${disableRes.status}`);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message, ...results }) };
  }
}
