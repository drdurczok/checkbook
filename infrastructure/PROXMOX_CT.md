# Proxmox CT Deployment

Use this runbook to create one Debian LXC container for Checkbook dev and prod.
Both environments run on the same CT with separate Compose projects and deploy
directories:

- dev: `/opt/checkbook/dev`
- prod: `/opt/checkbook/prod`

The deployment starts with fresh Postgres volumes. Public traffic should enter
through Cloudflare Tunnel and land on the `frontend` container at
`http://frontend:80`; nginx proxies same-origin `/api` requests to `api:8000`.
The optional private data-load API listens only on the internal container network,
is not published on the CT, and is never routed through the tunnel. Access it only
through a controlled administrative channel; its separate bearer token is required.

## 1. Choose values

```powershell
$ProxmoxHost = "root@192.0.2.10"
$CTID = "200"
$ProjectName = "checkbook"
$CtIp = "192.0.2.20"
$CtCidr = "$CtIp/24"
$Gateway = "192.0.2.1"
```

The addresses in this runbook are RFC 5737 documentation examples. Replace them
with your own network settings; choose an unused CT ID and appropriate storage.
Use a TLS-enabled registry. The bootstrap script leaves insecure registries
disabled unless explicitly enabled for an isolated test network.

Use `CT_IP=dhcp` in the create command if the CT should use DHCP.

## 2. Create a deploy key

```powershell
ssh-keygen -t ed25519 -C "$ProjectName-deploy" -f ".\$ProjectName-deploy"
```

Set the private key contents as GitLab CI variable `DEPLOY_SSH_KEY`. Install the
public key with the CT bootstrap script.

## 3. Push and run the CT bootstrap script

Run from the Checkbook repo root:

```powershell
scp .\infrastructure\scripts\proxmox-create-ct.sh "${ProxmoxHost}:/root/proxmox-create-ct.sh"
scp ".\$ProjectName-deploy.pub" "${ProxmoxHost}:/root/$ProjectName-deploy.pub"
ssh $ProxmoxHost "chmod +x /root/proxmox-create-ct.sh"
```

Static IP:

```powershell
ssh $ProxmoxHost "CT_ID=$CTID CT_HOSTNAME=$ProjectName CT_IP=$CtCidr CT_GATEWAY=$Gateway CT_STORAGE=local-lvm DEPLOY_PUBLIC_KEY_FILE=/root/$ProjectName-deploy.pub APP_DIR=/opt/$ProjectName /root/proxmox-create-ct.sh"
```

## 4. Verify the CT

```powershell
ssh $ProxmoxHost "pct status $CTID"
ssh $ProxmoxHost "pct exec $CTID -- hostname -I"
ssh $ProxmoxHost "pct exec $CTID -- docker version"
ssh -i ".\$ProjectName-deploy" deploy@$CtIp "docker version && ls -ld /opt/checkbook"
```

## 5. GitLab variables

Set these variables for Checkbook:

```text
DEPLOY_HOST=192.0.2.20
DEPLOY_USER=deploy
DEPLOY_SSH_KEY=<private key contents>
DEPLOY_KNOWN_HOSTS=<complete verified known_hosts record>
DB_PASSWORD=<masked>
DB_APP_PASSWORD=<masked>
TUNNEL_TOKEN=<environment-scoped token>
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://example.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUDIENCE=<Access application audience>
BACKUP_HOST_PATH=/srv/checkbook/backups
DATA_LOAD_HOST_PATH=/srv/checkbook/data-loads
ADMIN_SERVICE_TOKEN=<masked 32+ character credential>
```

Use environment-scoped `TUNNEL_TOKEN` values so dev and prod use different
Cloudflare tunnels.
See the repository README's **SSH host key** section for generating and verifying
`DEPLOY_KNOWN_HOSTS`; an IP address or fingerprint alone is not sufficient.
`BACKUP_HOST_PATH` is optional, but setting it explicitly is recommended when
backups should live on a mounted backup volume instead of under the deploy path.
`DATA_LOAD_HOST_PATH` is optional and defaults to a sibling directory under the
deploy path.
`ADMIN_SERVICE_TOKEN` is optional unless you need the private data-load API.

Optional public origin variables:

```text
FRONTEND_ORIGIN=https://checkbook.example
ALLOWED_ORIGINS=https://checkbook.example
GOOGLE_CLIENT_ID=<backend verifier client id>
```

## 6. Runner tags

Provision your own runners with these pipeline tags:

- `dev_runner` for tests, dev image builds, and dev deploys
- `prod_runner` for prod image builds and prod deploys

If registering runners manually, use tags `dev_runner,docker` for dev and
`prod_runner,docker` for prod, with Docker executor privileged mode enabled for
Docker-in-Docker build jobs.

## 7. Cloudflare routes

Configure each tunnel hostname route to target the frontend container:

```text
dev hostname  -> http://frontend:80
prod hostname -> http://frontend:80
```

Do not target `api:8000` for the public Checkbook app. The frontend container's
nginx config proxies `/api/*` and `/health` to the API service internally. The
deploy overlay does not publish API or private data-load API ports on the CT.

## 8. Deploy verification

Dev:

```powershell
ssh deploy@$CtIp "cd /opt/checkbook/dev && docker compose --env-file deploy.env -f docker-compose.yml -f docker-compose.deploy.yml ps"
ssh deploy@$CtIp "curl -fsS http://127.0.0.1:13009/health"
```

Prod:

```powershell
ssh deploy@$CtIp "cd /opt/checkbook/prod && docker compose --env-file deploy.env -f docker-compose.yml -f docker-compose.deploy.yml ps"
ssh deploy@$CtIp "curl -fsS http://127.0.0.1:13010/health"
```
