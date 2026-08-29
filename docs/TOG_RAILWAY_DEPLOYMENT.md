# The Operative Group: Railway deployment

This fork exposes a remote Model Context Protocol (MCP) server over Streamable
HTTP. Railway terminates HTTPS; the application listens on Railway's `PORT` and
uses forwarded-protocol headers when it constructs OAuth URLs.

## Recommended Version 1

Use static bearer authentication. It is the smallest secure configuration for a
single internal deployment and needs no persistent storage. Before publishing
the custom app, verify that the ChatGPT Business app-creation flow accepts the
static bearer credential for the MCP endpoint. If it requires a user sign-in
flow, use the existing OAuth option instead.

ChatGPT Business custom MCP apps are currently a beta capability. Workspace
admins/owners enable Developer Mode, create the app, provide the remote endpoint
and choose its authentication method before scanning tools. See the [official
OpenAI guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

## Railway configuration

Railway's native Node.js detection is sufficient. Do not add a Dockerfile,
`Procfile`, or `railway.json` for this service. The production start command is:

```sh
npm start
```

Set these Railway service variables:

| Variable | Required | Secret | Value / purpose |
| --- | --- | --- | --- |
| `FUB_API_KEY` | Yes | Yes | Follow Up Boss API key. |
| `MCP_TRANSPORT` | Yes | No | `http` |
| `MCP_BEARER_TOKEN` | Yes, Version 1 | Yes | A strong, randomly generated bearer token. |
| `FUB_SAFE_MODE` | Yes | No | `true` |
| `PORT` | Railway-managed | No | Do not set manually. |

Generate the bearer token locally and place it only in Railway's secret-variable
UI; for example: `openssl rand -hex 32`. Never commit it, add it to `.env`, or
place it in documentation or chat transcripts.

The remote MCP URL is `https://<railway-domain>/mcp`. Railway should use
`/health` as its health-check path. That endpoint reports operational metadata
only and does not return credentials.

HTTP mode refuses to start unless `MCP_BEARER_TOKEN` or `MCP_AUTH_PASSWORD` is
configured. `MCP_AUTH_DISABLED=true` works only with `NODE_ENV=development`; it
must never be configured on Railway.

## OAuth option (not Version 1)

OAuth 2.1 with dynamic client registration and PKCE remains available using
`MCP_AUTH_PASSWORD` (secret) instead of `MCP_BEARER_TOKEN`. It persists OAuth
clients and access tokens at `MCP_OAUTH_STORE_PATH`, which defaults to
`data/oauth-store.json`.

OAuth on Railway requires a persistent volume and an explicit path on that
volume, for example `MCP_OAUTH_STORE_PATH=/data/oauth-store.json`. Without it,
restart/redeploy loses clients and access tokens. The server's current OAuth
metadata does not advertise refresh-token support, so confirm the ChatGPT
Business OAuth requirements before choosing this mode.

## Smoke-test checklist

1. Add the required Railway variables; do not add `MCP_AUTH_DISABLED`.
2. Confirm Railway reports a healthy `GET /health` response.
3. Confirm `POST /mcp` without a bearer token returns `401`.
4. Configure the remote `https://<railway-domain>/mcp` endpoint in a private
   ChatGPT Business Developer Mode app and select the matching authentication.
5. Scan tools and confirm exactly 60 tools appear.
6. Confirm the only write tools are `createNote` and `createTask`.
7. Test a read operation and a deliberately confirmed write in a non-production
   CRM record before workspace publication.

No deploy, Railway configuration, or ChatGPT app publication is performed by
this repository preparation step.
