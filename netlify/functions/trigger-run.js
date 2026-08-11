// netlify/functions/trigger-run.js
//
// Lets the dashboard's buttons kick off a GitHub Actions run on demand,
// using the GitHub API's workflow_dispatch endpoint.

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, ADMIN_KEY } = process.env;

  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let runCount = "1";
  try {
    const body = JSON.parse(event.body || "{}");
    if (body.runCount) runCount = String(body.runCount);
  } catch (e) {
    // ignore, use default
  }

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/source.yml/dispatches`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { run_count: runCount },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { statusCode: res.status, body: JSON.stringify({ error: text }) };
    }

    return { statusCode: 200, body: JSON.stringify({ triggered: true, runCount }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
