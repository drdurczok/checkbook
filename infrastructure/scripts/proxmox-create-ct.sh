#!/usr/bin/env bash
set -euo pipefail

# Run this script on the Proxmox host as root.
# Override any value by exporting it before running the script, for example:
#   CT_ID=200 CT_IP=192.0.2.20/24 CT_GATEWAY=192.0.2.1 ./proxmox-create-ct.sh

CT_ID="${CT_ID:-200}"
CT_HOSTNAME="${CT_HOSTNAME:-checkbook}"
CT_PASSWORD="${CT_PASSWORD:-}"
CT_CORES="${CT_CORES:-2}"
CT_MEMORY_MB="${CT_MEMORY_MB:-4096}"
CT_SWAP_MB="${CT_SWAP_MB:-1024}"
CT_DISK_GB="${CT_DISK_GB:-32}"
CT_STORAGE="${CT_STORAGE:-local-lvm}"
CT_TEMPLATE_STORAGE="${CT_TEMPLATE_STORAGE:-local}"
CT_TEMPLATE="${CT_TEMPLATE:-debian-12-standard_12.7-1_amd64.tar.zst}"
CT_TEMPLATE_PATTERN="${CT_TEMPLATE_PATTERN:-debian-12-standard}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_IP="${CT_IP:-dhcp}"
CT_GATEWAY="${CT_GATEWAY:-}"
CT_UNPRIVILEGED="${CT_UNPRIVILEGED:-1}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PUBLIC_KEY_FILE="${DEPLOY_PUBLIC_KEY_FILE:-}"
APP_DIR="${APP_DIR:-/opt/${CT_HOSTNAME}}"
DOCKER_INSECURE_REGISTRY="${DOCKER_INSECURE_REGISTRY:-}"
ENABLE_DOCKER_INSECURE_REGISTRY="${ENABLE_DOCKER_INSECURE_REGISTRY:-false}"
INSTALL_GITLAB_RUNNER="${INSTALL_GITLAB_RUNNER:-false}"
GITLAB_RUNNER_URL="${GITLAB_RUNNER_URL:-}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "run this script as root on the Proxmox host"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

template_ref() {
  echo "${CT_TEMPLATE_STORAGE}:vztmpl/${CT_TEMPLATE}"
}

find_latest_template() {
  pveam available --section system |
    awk -v pattern="${CT_TEMPLATE_PATTERN}" '$2 ~ pattern { print $2 }' |
    sort -V |
    tail -n 1
}

net_config() {
  local config="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP}"
  if [ -n "${CT_GATEWAY}" ] && [ "${CT_IP}" != "dhcp" ]; then
    config="${config},gw=${CT_GATEWAY}"
  fi
  echo "${config}"
}

download_template_if_missing() {
  local template_path="/var/lib/vz/template/cache/${CT_TEMPLATE}"

  if [ "${CT_TEMPLATE_STORAGE}" != "local" ]; then
    echo "Template storage is '${CT_TEMPLATE_STORAGE}'. Skipping local template existence check."
    return
  fi

  pveam update

  if [ ! -f "${template_path}" ] &&
    ! pveam available --section system | awk '{ print $2 }' | grep -Fxq "${CT_TEMPLATE}"; then
    local discovered_template
    discovered_template="$(find_latest_template)"
    if [ -z "${discovered_template}" ]; then
      die "template '${CT_TEMPLATE}' was not found and no template matching '${CT_TEMPLATE_PATTERN}' is available. Run: pveam available --section system"
    fi
    echo "Template '${CT_TEMPLATE}' not found. Using latest matching template: ${discovered_template}"
    CT_TEMPLATE="${discovered_template}"
    template_path="/var/lib/vz/template/cache/${CT_TEMPLATE}"
  fi

  if [ -f "${template_path}" ]; then
    echo "Using existing template: ${template_path}"
    return
  fi

  echo "Template not found. Downloading ${CT_TEMPLATE}..."
  pveam download "${CT_TEMPLATE_STORAGE}" "${CT_TEMPLATE}"
}

create_container() {
  if pct status "${CT_ID}" >/dev/null 2>&1; then
    die "CT ${CT_ID} already exists"
  fi

  local password_args=()
  if [ -n "${CT_PASSWORD}" ]; then
    password_args=(--password "${CT_PASSWORD}")
  fi

  echo "Creating CT ${CT_ID} (${CT_HOSTNAME})..."
  pct create "${CT_ID}" "$(template_ref)" \
    --hostname "${CT_HOSTNAME}" \
    --cores "${CT_CORES}" \
    --memory "${CT_MEMORY_MB}" \
    --swap "${CT_SWAP_MB}" \
    --rootfs "${CT_STORAGE}:${CT_DISK_GB}" \
    --net0 "$(net_config)" \
    --features nesting=1,keyctl=1 \
    --unprivileged "${CT_UNPRIVILEGED}" \
    --onboot 1 \
    "${password_args[@]}"

  echo "Starting CT ${CT_ID}..."
  pct start "${CT_ID}"
}

wait_for_container() {
  echo "Waiting for CT ${CT_ID} to accept commands..."
  for _ in $(seq 1 60); do
    if pct exec "${CT_ID}" -- true >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  die "CT ${CT_ID} did not become ready in time"
}

install_base_packages() {
  echo "Installing base packages..."
  pct exec "${CT_ID}" -- apt-get update
  pct exec "${CT_ID}" -- apt-get install -y ca-certificates curl gnupg git openssh-server rsync
}

install_docker() {
  echo "Installing Docker inside CT ${CT_ID}..."
  pct exec "${CT_ID}" -- bash -lc "curl -fsSL https://get.docker.com | sh"

  if [ "${ENABLE_DOCKER_INSECURE_REGISTRY}" = "true" ] && [ -n "${DOCKER_INSECURE_REGISTRY}" ]; then
    echo "Configuring Docker insecure registry: ${DOCKER_INSECURE_REGISTRY}"
    pct exec "${CT_ID}" -- bash -lc "mkdir -p /etc/docker && printf '%s\n' '{' '  \"insecure-registries\": [\"${DOCKER_INSECURE_REGISTRY}\"]' '}' > /etc/docker/daemon.json"
  else
    echo "Skipping Docker insecure registry configuration."
  fi

  pct exec "${CT_ID}" -- systemctl enable --now docker
  pct exec "${CT_ID}" -- systemctl restart docker
}

create_deploy_user() {
  echo "Creating deploy user and app directory..."
  pct exec "${CT_ID}" -- bash -lc "id -u '${DEPLOY_USER}' >/dev/null 2>&1 || useradd -m -s /bin/bash '${DEPLOY_USER}'"
  pct exec "${CT_ID}" -- usermod -aG docker "${DEPLOY_USER}"
  pct exec "${CT_ID}" -- mkdir -p "${APP_DIR}"
  pct exec "${CT_ID}" -- chown "${DEPLOY_USER}:${DEPLOY_USER}" "${APP_DIR}"
}

install_deploy_key() {
  if [ -z "${DEPLOY_PUBLIC_KEY_FILE}" ]; then
    echo "DEPLOY_PUBLIC_KEY_FILE not set. Skipping deploy SSH key installation."
    return
  fi

  if [ ! -f "${DEPLOY_PUBLIC_KEY_FILE}" ]; then
    die "deploy public key file does not exist: ${DEPLOY_PUBLIC_KEY_FILE}"
  fi

  echo "Installing deploy SSH public key..."
  local public_key
  public_key="$(cat "${DEPLOY_PUBLIC_KEY_FILE}")"

  pct exec "${CT_ID}" -- install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
  pct exec "${CT_ID}" -- bash -lc "printf '%s\n' '${public_key}' >> '/home/${DEPLOY_USER}/.ssh/authorized_keys'"
  pct exec "${CT_ID}" -- chown "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  pct exec "${CT_ID}" -- chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
}

install_gitlab_runner() {
  if [ "${INSTALL_GITLAB_RUNNER}" != "true" ]; then
    echo "INSTALL_GITLAB_RUNNER is not true. Skipping GitLab Runner installation."
    return
  fi

  echo "Installing GitLab Runner inside CT ${CT_ID}..."
  pct exec "${CT_ID}" -- bash -lc "curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | bash"
  pct exec "${CT_ID}" -- apt-get install -y gitlab-runner
  pct exec "${CT_ID}" -- usermod -aG docker gitlab-runner
  pct exec "${CT_ID}" -- systemctl enable --now gitlab-runner

  if [ -n "${GITLAB_RUNNER_URL}" ]; then
    echo "GitLab Runner installed. Use ${GITLAB_RUNNER_URL} project or group runner settings with tags dev_runner, prod_runner, and docker."
  else
    echo "GitLab Runner installed. Register or assign runners with tags dev_runner, prod_runner, and docker."
  fi
}

print_summary() {
  cat <<EOF

CT bootstrap complete.

CT ID:       ${CT_ID}
Hostname:    ${CT_HOSTNAME}
Deploy user: ${DEPLOY_USER}
App dir:     ${APP_DIR}

Next steps:
1. Confirm the CT IP in Proxmox or with: pct exec ${CT_ID} -- hostname -I
2. Add the deploy user's private key to GitLab CI/CD variables as DEPLOY_SSH_KEY.
3. Set DEPLOY_HOST to the CT IP address, DEPLOY_USER to ${DEPLOY_USER}, and deploy paths to /opt/checkbook/dev and /opt/checkbook/prod.
4. Ensure runners with tags dev_runner, prod_runner, and docker are available to the project.
5. Configure separate dev and prod Cloudflare tunnel tokens, each routing its hostname to http://frontend:80.

EOF
}

main() {
  require_root
  require_command pct
  require_command pveam

  download_template_if_missing
  create_container
  wait_for_container
  install_base_packages
  install_docker
  create_deploy_user
  install_deploy_key
  install_gitlab_runner
  print_summary
}

main "$@"
