// netlify/functions/resume-run.js
//
// Re-enables the workflow after stop-run.js disabled it - without this,
// "stop" would be permanent until someone manually re-enabled it on GitHub.

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, ADMIN_KEY } = process.env;

  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/source.yml/enable`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (res.ok || res.status === 204) {
      return { statusCode: 200, body: JSON.stringify({ resumed: true }) };
    }
    return { statusCode: res.status, body: JSON.stringify({ error: `GitHub returned ${res.status}` }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
