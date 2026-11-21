# Deploying BHGBrain on an Azure Linux VM with Tailscale

This guide runs one shared BHGBrain server on an Azure Linux VM. Your laptops,
desktops, WSL instances and build agents all connect to it, so every MCP client
reads and writes the same memory.

The VM has **no inbound ports open to the internet**. Clients reach it only over
your [Tailscale](https://tailscale.com) tailnet, and two separate checks guard
each request:

1. **Tailscale access rules** decide which devices can open a connection to
   the VM at all.
2. **BHGBrain's bearer token** decides which callers can use the API once
   connected.

```
 Laptop / desktop / WSL / CI agent          Azure VM (Ubuntu 24.04)
 ┌──────────────────────────────┐          ┌──────────────────────────────────────────┐
 │ MCP client                   │          │ tailscaled                               │
 │  http://bhgbrain:3721/mcp    │ WireGuard│  serve --tcp 3721 → 127.0.0.1:3721        │
 │  Authorization: Bearer …     ├─────────►│        │                                 │
 │ tailscaled                   │ (tailnet)│        ▼                                 │
 └──────────────────────────────┘          │ docker compose (/opt/bhgbrain)           │
                                           │  bhgbrain  127.0.0.1:3721  → ./data      │
 Internet ──── ✗ NSG: no inbound rules     │  qdrant    (no published port) → ./qdrant│
                                           └──────────────────────────────────────────┘
```

Because traffic travels inside Tailscale's WireGuard tunnel, plain HTTP on the
tailnet is already encrypted from the client device to the VM. TLS is optional
(see [Optional: HTTPS on the tailnet](#optional-https-on-the-tailnet)).

The commands below use these placeholder values. Replace them with your own:

| Placeholder | Meaning | Example |
|---|---|---|
| `bhgbrain-rg` | Resource group | `bhgbrain-rg` |
| `canadacentral` | Azure region | `canadacentral` |
| `bhgbrain-vm` | VM name | `bhgbrain-vm` |
| `bhgadmin` | Linux admin user | `bhgadmin` |
| `kv-bhgbrain-xxxx` | Key Vault name (must be globally unique) | `kv-bhgbrain7f3a` |
| `bhgbrain` | Machine name on the tailnet | `bhgbrain` |
| `<tailnet>` | Your tailnet's DNS name | `tail1234.ts.net` |

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Prepare the tailnet](#2-prepare-the-tailnet)
3. [Create the VM](#3-create-the-vm)
4. [Install Docker and Tailscale on the VM](#4-install-docker-and-tailscale-on-the-vm)
5. [Lay out and start BHGBrain](#5-lay-out-and-start-bhgbrain)
6. [Publish the server on the tailnet](#6-publish-the-server-on-the-tailnet)
7. [Connect your devices](#7-connect-your-devices)
8. [Manage device access](#8-manage-device-access)
9. [Operate the server](#9-operate-the-server)
10. [Troubleshooting](#10-troubleshooting)
11. [Security notes and limits](#11-security-notes-and-limits)

---

## 1. Prerequisites

- An Azure subscription, and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
  signed in with `az login`.
- A Tailscale account with admin rights on the tailnet, and
  [MagicDNS](https://tailscale.com/kb/1081/magicdns) turned on (it is on by
  default for new tailnets).
- A key for an embedding provider: an OpenAI API key, or an Azure AI Foundry
  deployment. For Foundry, `scripts/azure/` in this repo provisions one (see
  [`scripts/azure/README.md`](../scripts/azure/README.md)).
- `ssh-keygen` and `openssl` on your workstation. Git Bash, WSL, macOS and Linux
  all include them.

**VM size.** One user, or a small team, runs comfortably on a `Standard_B2ms`
(2 vCPU, 8 GiB) with a 64 GiB OS disk. Qdrant keeps its vectors in memory, so
size up if you expect hundreds of thousands of memories.

---

## 2. Prepare the tailnet

### 2.1 Write the access policy

In the Tailscale admin console, open **Access controls** and edit the policy
file. The example below:

- creates a **tag** for the server, so the VM is owned by the tailnet rather
  than by one person's account, and its node key doesn't expire;
- creates a **group** of people allowed to use the brain;
- opens **only** port 3721 (the API) to that group, and port 22 (SSH) to admins.

```jsonc
{
  "groups": {
    "group:bhgbrain-users":  ["alice@example.com", "bob@example.com"],
    "group:bhgbrain-admins": ["alice@example.com"],
  },

  "tagOwners": {
    "tag:bhgbrain": ["group:bhgbrain-admins"],
  },

  "grants": [
    // People in bhgbrain-users can reach the MCP/HTTP API from any of their devices.
    {"src": ["group:bhgbrain-users"],  "dst": ["tag:bhgbrain"], "ip": ["tcp:3721"]},

    // Admins can also SSH to the VM over the tailnet.
    {"src": ["group:bhgbrain-admins"], "dst": ["tag:bhgbrain"], "ip": ["tcp:22"]},

    // ...keep your tailnet's other grants/ACLs here...
  ],
}
```

> **Remove the default allow-all rule.** A new tailnet's policy contains an
> allow-all rule (`"src": ["*"], "dst": ["*"]` in `grants`, or
> `"action": "accept"` from `*` to `*:*` in `acls`). Tailscale rules only ever
> add access, so while that rule exists every device on the tailnet can still
> reach every port on the VM. Replace it with explicit rules like the ones above.

If your policy file still uses the older `acls` syntax, write the equivalent
rules this way:

```jsonc
"acls": [
  {"action": "accept", "src": ["group:bhgbrain-users"],  "dst": ["tag:bhgbrain:3721"]},
  {"action": "accept", "src": ["group:bhgbrain-admins"], "dst": ["tag:bhgbrain:22"]},
],
```

### 2.2 Create a one-time auth key for the VM

The VM will have no inbound SSH when it first boots, so it joins the tailnet
non-interactively with an auth key. In the admin console, go to
**Settings → Keys → Generate auth key** and choose:

- **Reusable:** off
- **Expiration:** 1 day (the shortest that suits you)
- **Pre-approved:** on, if device approval is enabled
- **Tags:** `tag:bhgbrain`

Copy the key (`tskey-auth-…`). After the VM uses it once, it can't be used
again. Keep it out of shell history and files you commit.

---

## 3. Create the VM

### 3.1 SSH key and Key Vault

Create a dedicated SSH key, and keep a canonical copy in Key Vault so other
admins (and future you) can recover it:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/bhgbrain-vm_ed25519 -C "bhgadmin@bhgbrain-vm"

az group create --name bhgbrain-rg --location canadacentral

az keyvault create --resource-group bhgbrain-rg --name kv-bhgbrain-xxxx \
  --location canadacentral --enable-rbac-authorization true

# RBAC vaults need a data-plane role, even for the person who created the vault.
az role assignment create --role "Key Vault Secrets Officer" \
  --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --scope "$(az keyvault show -n kv-bhgbrain-xxxx --query id -o tsv)"

az keyvault secret set --vault-name kv-bhgbrain-xxxx \
  --name bhgbrain-vm-ssh-private-key --file ~/.ssh/bhgbrain-vm_ed25519
az keyvault secret set --vault-name kv-bhgbrain-xxxx \
  --name bhgbrain-vm-ssh-public-key  --file ~/.ssh/bhgbrain-vm_ed25519.pub
```

> In Git Bash on Windows, run `export MSYS_NO_PATHCONV=1` first. Otherwise Git
> Bash rewrites arguments that start with `/subscriptions/...` into Windows
> paths and the `az` call fails.

### 3.2 Create the VM with no inbound rules

```bash
az vm create \
  --resource-group bhgbrain-rg \
  --name bhgbrain-vm \
  --image Ubuntu2404 \
  --size Standard_B2ms \
  --os-disk-size-gb 64 \
  --admin-username bhgadmin \
  --ssh-key-values ~/.ssh/bhgbrain-vm_ed25519.pub \
  --public-ip-sku Standard \
  --nsg-rule NONE
```

`--nsg-rule NONE` creates the network security group (`bhgbrain-vmNSG`) **without**
the usual SSH-from-anywhere rule. Confirm that it has no custom inbound rules:

```bash
az network nsg rule list --resource-group bhgbrain-rg --nsg-name bhgbrain-vmNSG -o table
# (empty output = only Azure's default rules, which deny inbound internet traffic)
```

**Why the VM still gets a public IP.** The VM needs **outbound** internet
access to pull Docker images, reach your embedding provider, and connect to
Tailscale. On virtual networks created with recent Azure API versions (after
31 March 2026), subnets are private by default, and a VM with no explicit
outbound method has no internet access at all
([default outbound access](https://learn.microsoft.com/azure/virtual-network/ip-services/default-outbound-access)).
A Standard public IP gives the VM that outbound path. It accepts no inbound
traffic unless an NSG rule allows it, and here none does.

If you'd rather the VM had no public IP at all, attach an
[Azure NAT Gateway](https://learn.microsoft.com/azure/nat-gateway/nat-overview) to
the subnet and create the VM with `--public-ip-address ""` instead.

Tailscale works through Azure's NAT without any inbound rule. It punches a
direct path when it can, and otherwise relays through Tailscale's DERP
servers. You can optionally allow inbound UDP 41641 to improve the chance of a
direct connection, but nothing breaks without it.

---

## 4. Install Docker and Tailscale on the VM

SSH isn't reachable yet, so run the first setup with **Azure Run Command**. It
executes a script as root through the VM agent and needs no network path to
the VM.

Save this locally as `bootstrap-vm.sh`:

```bash
#!/bin/bash
set -euo pipefail

# --- Docker Engine + Compose plugin (official apt repository) ---
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# --- Tailscale ---
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
```

Run it, then join the tailnet with the one-time key from step 2.2:

```bash
az vm run-command invoke -g bhgbrain-rg -n bhgbrain-vm \
  --command-id RunShellScript --scripts @bootstrap-vm.sh

az vm run-command invoke -g bhgbrain-rg -n bhgbrain-vm \
  --command-id RunShellScript \
  --scripts "tailscale up --auth-key=tskey-auth-REPLACE_ME --hostname=bhgbrain"
```

The VM now appears in the Tailscale admin console as `bhgbrain`, tagged
`tag:bhgbrain`. From an admin device on the tailnet, SSH in over Tailscale:

```bash
ssh -i ~/.ssh/bhgbrain-vm_ed25519 -o IdentitiesOnly=yes bhgadmin@bhgbrain
```

From here on, every step runs **on the VM** over that SSH session. If SSH is
ever unavailable, `az vm run-command invoke … --scripts "<command>"` still
works as a fallback.

---

## 5. Lay out and start BHGBrain

### 5.1 Directories and source

```bash
sudo mkdir -p /opt/bhgbrain/data /opt/bhgbrain/qdrant
sudo git clone https://github.com/Big-Hat-Group-Inc/BHGBrain.git /opt/bhgbrain/src

# The bhgbrain container runs as the unprivileged `node` user (uid 1000),
# so it must own the directory it writes SQLite, config and backups into.
sudo chown 1000:1000 /opt/bhgbrain/data

# This repo ships a compose file built for exactly this layout.
sudo cp /opt/bhgbrain/src/deploy/azure-vm/docker-compose.yml /opt/bhgbrain/docker-compose.yml
```

Read [`deploy/azure-vm/docker-compose.yml`](../deploy/azure-vm/docker-compose.yml)
before you start it. It publishes the API on `127.0.0.1:3721` **only**, and
gives Qdrant no published port at all, so only the `bhgbrain` container can
reach Qdrant.

### 5.2 Secrets (`.env`)

Generate a bearer token, and store a copy in Key Vault so clients can be
configured from there:

```bash
TOKEN=$(openssl rand -hex 24)

sudo tee /opt/bhgbrain/.env >/dev/null <<EOF
BHGBRAIN_TOKEN=${TOKEN}
OPENAI_API_KEY=sk-REPLACE_ME
# For Azure AI Foundry embeddings use this instead (and see 5.4):
# AZURE_FOUNDRY_API_KEY=REPLACE_ME
EOF
sudo chmod 600 /opt/bhgbrain/.env
echo "$TOKEN"   # copy this into Key Vault from your workstation (next command)
unset TOKEN
```

On your workstation:

```bash
az keyvault secret set --vault-name kv-bhgbrain-xxxx --name bhgbrain-token --value '<token>'
```

If you leave `BHGBRAIN_TOKEN` out, the container generates a token on first
start and saves it to `/opt/bhgbrain/data/bhgbrain-token`. Setting the token
yourself means you can rotate it on purpose (see [section 8](#8-manage-device-access)).

### 5.3 Start

```bash
cd /opt/bhgbrain
sudo docker compose up -d --build
sudo docker compose ps
curl -s http://127.0.0.1:3721/health/live
curl -s -H "Authorization: Bearer $(sudo grep ^BHGBRAIN_TOKEN= .env | cut -d= -f2)" \
  http://127.0.0.1:3721/health
```

The first build takes a few minutes. `/health` should report `sqlite`,
`qdrant` and `embedding` as healthy.

### 5.4 Configure the embedding provider

On first start the server writes its full default configuration to
`/opt/bhgbrain/data/config.json`. With the default OpenAI provider and
`OPENAI_API_KEY` in `.env`, you're done.

For Azure AI Foundry, edit the `embedding` block of
`/opt/bhgbrain/data/config.json` (field reference: README §
[Configuration](../README.md#configuration)):

```jsonc
"embedding": {
  "provider": "azure-foundry",
  "model": "text-embedding-3-small",
  "dimensions": 1536,
  "azure": {
    "resource_name": "<your-foundry-resource>"
    // api_key_env defaults to AZURE_FOUNDRY_API_KEY
  }
}
```

Then put `AZURE_FOUNDRY_API_KEY` in `.env` and recreate the container so it
reads the new environment:

```bash
sudo docker compose up -d --force-recreate bhgbrain
```

> Pick the embedding provider, model and dimensions **before** you store real
> memories. Changing them later means re-embedding every memory (README §
> [Embedding Model Migration](../README.md#embedding-model-migration)).

---

## 6. Publish the server on the tailnet

`tailscale serve` listens on the VM's tailnet address and forwards connections
to the loopback-only port Docker published:

```bash
sudo tailscale serve --bg --tcp 3721 tcp://127.0.0.1:3721
sudo tailscale serve status
```

`--bg` saves the setting, so it survives reboots and restarts of `tailscaled`.
Clients now reach the server at:

- `http://bhgbrain:3721/mcp` (MagicDNS short name), or
- `http://bhgbrain.<tailnet>:3721/mcp` (full name; use this where short names
  don't resolve, such as WSL or inside containers).

To stop publishing: `sudo tailscale serve --tcp 3721 off`.

> **Never use `tailscale funnel` for this server.** Funnel publishes a service to
> the **public internet**. Likewise, never change the compose port mapping to
> `3721:3721` or `0.0.0.0:3721:3721`. Either one exposes the memory API outside
> the tailnet.

### Optional: HTTPS on the tailnet

WireGuard already encrypts the traffic, so HTTPS adds no confidentiality here.
Some clients do insist on an `https://` URL, though. If you
[enable HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) for
the tailnet, Tailscale can terminate TLS with a valid certificate for the
machine's full name:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:3721
# clients: https://bhgbrain.<tailnet>/mcp
```

Note that turning on HTTPS certificates publishes the machine name in public
Certificate Transparency logs.

---

## 7. Connect your devices

Do this on every device that should use the brain.

1. **Install Tailscale** and sign in as a user in `group:bhgbrain-users`:
   <https://tailscale.com/download>.
2. **Check that the device can reach the server:**

   ```bash
   curl http://bhgbrain:3721/health/live
   # → {"status":"ok", ...}
   ```

3. **Get the bearer token** from Key Vault (or from whoever administers the
   server):

   ```bash
   az keyvault secret show --vault-name kv-bhgbrain-xxxx --name bhgbrain-token --query value -o tsv
   ```

4. **Point your MCP client at the server.** Every client uses the same URL and
   the same `Authorization` header.

   **Claude Code:**

   ```bash
   claude mcp add --transport http --scope user bhgbrain \
     http://bhgbrain:3721/mcp \
     --header "Authorization: Bearer <token>"
   ```

   **Clients configured with JSON** that support Streamable HTTP directly
   (OpenClaw / mcporter and others; see README §
   [MCP Client Configuration](../README.md#mcp-client-configuration)):

   ```json
   {
     "mcpServers": {
       "bhgbrain": {
         "transport": "http",
         "url": "http://bhgbrain:3721/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

   **Clients that only launch local (stdio) servers**, such as Claude Desktop's
   `claude_desktop_config.json`, can reach the server through a local
   stdio-to-HTTP bridge such as [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).
   The bridge runs on the device, so it can use the tailnet:

   ```json
   {
     "mcpServers": {
       "bhgbrain": {
         "command": "npx",
         "args": ["mcp-remote", "http://bhgbrain:3721/mcp", "--allow-http",
                  "--header", "Authorization:${AUTH_HEADER}"],
         "env": { "AUTH_HEADER": "Bearer <token>" }
       }
     }
   }
   ```

   > **Cloud-hosted connectors can't reach this server.** Remote MCP
   > "connectors" added in a web or mobile chat app (for example claude.ai
   > custom connectors) connect from the vendor's cloud, which isn't on your
   > tailnet. That's the price of keeping the server off the internet. Only
   > clients running on your own tailnet devices can use it.

   **Scripts and the REST API:**

   ```bash
   curl -X POST http://bhgbrain:3721/tool/recall \
     -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
     -d '{"query": "how do we deploy bhgbrain"}'
   ```

All devices share one server process and one database, so a memory saved from
your laptop is immediately available to recall from your desktop. You don't
need the [multi-device](../README.md#multi-device-memory) setup (one SQLite per
device sharing a Qdrant) for this. That setup is for running several separate
servers.

**Headless machines** (CI runners, build agents, a shared lab PC) shouldn't sign
in as a person. Give them a tag such as `tag:bhgbrain-client`, add it to the
`src` of the port-3721 grant, and join them with a tagged auth key, just as you
did for the VM.

---

## 8. Manage device access

| Task | How |
|---|---|
| **Give a new person access** | Add them to `group:bhgbrain-users` in the policy file, then give them the token. |
| **Add a person's new device** | Nothing to change on the server. Grants follow the user, so the device works as soon as it joins the tailnet signed in as that user. |
| **Remove one device** (lost or retired) | Admin console → **Machines** → the device → **Remove**. It can no longer reach the VM at all. |
| **Remove a person** | Remove them from `group:bhgbrain-users` (and from the tailnet, if appropriate), then **rotate the token**. They know the shared token. |
| **Suspect the token leaked** | Rotate the token (below). Tailscale rules still block anyone off the tailnet, so a leaked token is exploitable only from a device that already has access. |
| **Share with someone outside your tailnet** | Use Tailscale [machine sharing](https://tailscale.com/kb/1084/sharing) to share `bhgbrain` with their account, and give them the token. |
| **See who can reach the server** | Admin console → **Access controls → Preview rules** for `tag:bhgbrain`, or `tailscale status` on the VM. |

**Rotate the bearer token:**

```bash
# on the VM
NEW=$(openssl rand -hex 24)
sudo sed -i "s/^BHGBRAIN_TOKEN=.*/BHGBRAIN_TOKEN=${NEW}/" /opt/bhgbrain/.env
cd /opt/bhgbrain && sudo docker compose up -d --force-recreate bhgbrain
echo "$NEW"; unset NEW
```

Then update the `bhgbrain-token` secret in Key Vault and the header in every
client's configuration. Clients keep getting `401` responses until you do.

---

## 9. Operate the server

### Redeploy a new version

```bash
cd /opt/bhgbrain
sudo git -c safe.directory=/opt/bhgbrain/src -C src pull --ff-only
sudo docker compose up -d --build bhgbrain
curl -s http://127.0.0.1:3721/health/live
```

Read the README's [Upgrading](../README.md#upgrading) section before you jump
several versions. MCP clients reconnect on their own after the restart.

> **Never run `docker compose down -v`.** With bind mounts the data survives it,
> but the habit is dangerous with named volumes. `docker compose down` (without
> `-v`) or `up -d` is all you need.

### Backups

- **Application backups.** These cover SQLite, the source of truth for every
  memory and its metadata, and land in `/opt/bhgbrain/data/backups/`:

  ```bash
  curl -s -X POST http://127.0.0.1:3721/tool/backup \
    -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
    -d '{"action": "create"}'
  ```

  Run it from a cron job or systemd timer on the VM, and copy the files off
  the VM (for example to Azure Blob Storage) so a lost disk doesn't take the
  backups with it. Restore and retention are covered in README §
  [Backup & Restore](../README.md#backup--restore).
- **VM-level backups.** Enable [Azure Backup](https://learn.microsoft.com/azure/backup/backup-azure-vms-introduction)
  for the VM, or take scheduled disk snapshots. These capture `data/` and
  `qdrant/` together.

Qdrant's vectors can be rebuilt from SQLite (README §
[Repair and Recovery](../README.md#repair-and-recovery)). Rebuilding costs
embedding calls, though, so keep snapshots that include `qdrant/` as well.

### Logs and health

```bash
cd /opt/bhgbrain
sudo docker compose logs -f --tail=200 bhgbrain
sudo docker compose ps          # shows healthy/unhealthy from the image HEALTHCHECK
```

### Upgrade Qdrant

Change the `qdrant/qdrant:vX.Y.Z` tag in `/opt/bhgbrain/docker-compose.yml`,
take a snapshot or backup first, then run `sudo docker compose up -d qdrant`.
Qdrant supports upgrading one minor version at a time; check its release notes
before larger jumps.

### Patch the VM

Ubuntu installs security updates automatically through `unattended-upgrades`.
Reboot occasionally for kernel updates. Docker containers (`restart:
unless-stopped`) and `tailscale serve` come back on their own.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `curl http://bhgbrain:3721/...` hangs or the connection is refused, from a client | The device isn't allowed by the policy (check **Preview rules**), isn't signed in to Tailscale, or `tailscale serve status` on the VM shows nothing. Re-run step 6. |
| Works on the VM (`127.0.0.1:3721`) but not over the tailnet | `tailscale serve` isn't configured, or it forwards to the wrong port. |
| `bhgbrain` doesn't resolve | MagicDNS is off, or the client (often WSL2 or a container) doesn't use Tailscale's DNS. Use `bhgbrain.<tailnet>` or the VM's `100.x.y.z` address. In WSL, installing Tailscale inside the distro also works. |
| `401 Unauthorized` | Missing or out-of-date `Authorization: Bearer` header. Compare the client's token with `BHGBRAIN_TOKEN` in `/opt/bhgbrain/.env`. |
| `429 RATE_LIMITED` with several devices active | See the rate-limit note in [section 11](#11-security-notes-and-limits). Raise `security.rate_limit_rpm` in `config.json`. |
| Container restarts in a loop; logs mention `EACCES` on `/data` | `/opt/bhgbrain/data` isn't owned by uid 1000. Run `sudo chown -R 1000:1000 /opt/bhgbrain/data`. |
| `/health` shows `embedding` degraded | Missing or wrong API key in `.env`, or the provider settings in `config.json` are wrong. After editing `.env`, run `up -d --force-recreate bhgbrain`; a plain `restart` doesn't reload it. |
| The VM can't reach the internet (image pull or `apt` fails) | No outbound method on a private subnet. See [3.2](#32-create-the-vm-with-no-inbound-rules). |
| Lost SSH access | Use `az vm run-command invoke … --command-id RunShellScript --scripts "<cmd>"`, or reset the key with `az vm user update --username bhgadmin --ssh-key-value <pubkey>`. |

---

## 11. Security notes and limits

- **Two locks, both needed.** Tailscale's access rules are the main boundary:
  devices that aren't allowed can't even open a connection. The bearer token
  is the second lock. Keep both: don't set `BHGBRAIN_ALLOW_UNAUTHENTICATED`
  just because the network is private.
- **One shared token.** BHGBrain checks a single bearer token, so you can't
  revoke one person's API access without rotating it for everyone. Use
  Tailscale to cut off a device or a person, and rotate the token when someone
  leaves.
- **Rate limiting can't tell devices apart in this setup.** BHGBrain rate-limits
  per client IP (`security.rate_limit_rpm`, 100 requests per minute by
  default). Connections pass through `tailscale serve` and Docker's port
  forwarding, so every device arrives from the same address and shares **one**
  bucket. With several busy clients, raise `security.rate_limit_rpm` in
  `config.json`. Leave `security.trust_proxy` at `false`: neither hop sets an
  `X-Forwarded-For` header you can rely on.
- **No inbound internet exposure.** The NSG has no inbound allow rules, Docker
  publishes the API on loopback only, and Qdrant publishes nothing. Keep all
  three that way. Opening port 3721 or 6333 to the internet bypasses Tailscale
  entirely, and Qdrant has no authentication of its own.
- **Secrets.** The API keys and token live only in `/opt/bhgbrain/.env` (root,
  mode 600) on the VM and in Key Vault. `config.json` stores only the *names*
  of the environment variables that hold keys (README §
  [Config vs. environment](../README.md#configuration)), never the keys
  themselves.
- **Admin access.** SSH is reachable only over the tailnet, and only from
  `group:bhgbrain-admins`. If you'd rather not manage SSH keys at all, you can
  turn on [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh) on the VM
  (`sudo tailscale set --ssh`) and add an `ssh` rule to the policy.
