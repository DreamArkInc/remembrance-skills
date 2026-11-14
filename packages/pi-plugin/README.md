# Remembrance for Pi

Native Pi extension for reusable skill discovery, organization preferences,
feedback, protected local learning, recovery, and connection diagnostics.
Requires Node.js 22.19 or newer and Pi 1.5.2 or newer.

```sh
pi install npm:@remembrance-ai/pi-plugin@0.2.25
```

Restart Pi after installation. The extension registers its bundled `remembrance`
MCP server through Pi's native MCP support. It uses the existing Remembrance
environment variables or `~/.config/remembrance/config.json` (under
`XDG_CONFIG_HOME` when set); installation does not copy credentials into Pi
configuration. Never put organization keys in a prompt or commit them.

Use Remembrance tools directly when automatic context is insufficient. Discovery
and preference context use the same bounded hooks as the other native plugins.
Private capture uses the existing encrypted local outbox and exact private
actions; a retained draft is not a submitted contribution. Missing source
authority leaves a recoverable hold. A host denial never switches transport.

The first private write in each consent lane offers **Allow this time**,
**Always allow**, or **Deny** in Pi. Always allow saves a protected receipt for
that organization, registry, and lane. Headless runs require a matching saved
receipt. Administrator operations require approval for every exact operation;
a saved private-learning receipt never approves an administrator write.

Update with:

```sh
pi install npm:@remembrance-ai/pi-plugin@latest
```

Set `REMEMBRANCE_AUTO_QUERY=0` to disable automatic queries. Use the MCP
`get_connection_status` and `run_connection_doctor` tools for diagnostics.
