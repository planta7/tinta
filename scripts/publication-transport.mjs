import assert from "node:assert/strict";

/** Errors deliberately omit service response text, URLs, commands and tokens. */
export function httpTransport(fetcher = fetch) {
  return async (
    url,
    {
      method = "GET",
      headers = {},
      body,
      binary = false,
      missing = false,
    } = {},
  ) => {
    const response = await fetcher(url, {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(
        `Destination request failed (${response.status})`,
      );
      error.code = [401, 403].includes(response.status)
        ? "CREDENTIAL_EXPIRED"
        : "DESTINATION_ERROR";
      throw error;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      assert.ok(size <= 128 * 1024 * 1024, "Destination response too large");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return binary
      ? bytes
      : bytes.length
        ? JSON.parse(bytes.toString("utf8"))
        : null;
  };
}

export function githubApi(request, token) {
  assert.ok(token, "Missing GitHub credential");
  return (method, path, body) => {
    assert.ok(path.startsWith("/repos/") && !path.includes(".."));
    return request(`https://api.github.com${path}`, {
      method,
      missing: method === "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
}

export async function entraCredential(request, env, binding) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
  for (const id of [binding.tenant, binding.client]) {
    assert.match(id, /^[a-f0-9-]{36}$/i, "Missing federation binding");
  }
  const oidc = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.equal(oidc.protocol, "https:");
  assert.ok(oidc.hostname.endsWith(".actions.githubusercontent.com"));
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  oidc.searchParams.set("audience", "api://AzureADTokenExchange");
  const assertion = await request(oidc.href, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  assert.ok(typeof assertion.value === "string" && assertion.value.length > 0);
  const result = await request(
    `https://login.microsoftonline.com/${binding.tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: binding.client,
        scope: "499b84ac-1321-427f-aa17-267ca6975798/.default",
        grant_type: "client_credentials",
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion.value,
      }).toString(),
    },
  );
  assert.ok(
    result.access_token && result.token_type.toLowerCase() === "bearer",
  );
  assert.ok(result.expires_in > 60, "Expired federation credential");
  return result.access_token;
}
