#!/bin/sh

set -eu
umask 077

require_var() {
  name="$1"
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Missing required variable: $name" >&2
    missing_required_vars=1
  fi
}

urlencode() {
  jq -rn --arg value "$1" '$value | @uri'
}

write_dotenv() {
  name="$1"
  value="$2"
  case "$value" in
    *"
"*)
      echo "$name must not contain a newline" >&2
      exit 1
      ;;
  esac
  escaped=$(printf '%s' "$value" | sed -e "s/'/\\\\'/g" -e 's/\$/$$/g')
  printf "%s='%s'\n" "$name" "$escaped" >>"$deploy_env_file"
}

write_shell_assignment() {
  name="$1"
  value="$2"
  case "$value" in
    *"
"*)
      echo "$name must not contain a newline" >&2
      exit 1
      ;;
  esac
  escaped=$(printf '%s' "$value" | sed "s/'/'\\\\''/g")
  printf "%s='%s'\n" "$name" "$escaped" >>"$registry_env_file"
}

missing_required_vars=0
for name in \
  DEPLOY_HOST \
  DEPLOY_USER \
  DB_PASSWORD \
  DB_APP_PASSWORD \
  TUNNEL_TOKEN \
  CI_REGISTRY \
  CI_REGISTRY_USER \
  CI_REGISTRY_PASSWORD \
  CI_REGISTRY_IMAGE \
  CI_COMMIT_SHA \
  TARGET_ENV \
  CLOUDFLARE_ACCESS_TEAM_DOMAIN \
  CLOUDFLARE_ACCESS_AUDIENCE
do
  require_var "$name"
done

if [ "$missing_required_vars" -ne 0 ]; then
  exit 1
fi

remote_dir="${DEPLOY_PATH:-/opt/checkbook/$TARGET_ENV}"
backup_host_path="${BACKUP_HOST_PATH:-$remote_dir/backups}"
data_load_host_path="${DATA_LOAD_HOST_PATH:-$remote_dir/data-loads}"
project_name="${COMPOSE_PROJECT_NAME:-checkbook-$TARGET_ENV}"
if [ "$TARGET_ENV" = "dev" ]; then
  default_frontend_host_port=13009
else
  default_frontend_host_port=13010
fi
frontend_host_port="${FRONTEND_HOST_PORT:-$default_frontend_host_port}"
frontend_origin="${FRONTEND_ORIGIN:-http://localhost:$frontend_host_port}"
allowed_origins="${ALLOWED_ORIGINS:-$frontend_origin}"
deploy_port="${DEPLOY_PORT:-22}"
admin_service_token="${ADMIN_SERVICE_TOKEN:-}"
if [ -n "$admin_service_token" ]; then
  admin_listen_address="0.0.0.0:8001"
  data_load_staging_root="/var/lib/checkbook/data-loads"
else
  admin_listen_address=""
  data_load_staging_root=""
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

deploy_env_file="$tmp_dir/deploy.env"
registry_env_file="$tmp_dir/registry.env"

: >"$deploy_env_file"
encoded_db_password=$(urlencode "$DB_PASSWORD")
encoded_app_password=$(urlencode "$DB_APP_PASSWORD")
write_dotenv TARGET_ENV "$TARGET_ENV"
write_dotenv COMPOSE_PROJECT_NAME "$project_name"
write_dotenv DB_PASSWORD "$DB_PASSWORD"
write_dotenv DATABASE_URL "postgresql://checkbook_admin:$encoded_db_password@postgres:5432/checkbook"
write_dotenv APP_DATABASE_URL "postgresql://checkbook_app:$encoded_app_password@postgres:5432/checkbook"
write_dotenv DB_APP_PASSWORD "$DB_APP_PASSWORD"
write_dotenv TUNNEL_TOKEN "$TUNNEL_TOKEN"
write_dotenv API_IMAGE "$CI_REGISTRY_IMAGE/api:$CI_COMMIT_SHA"
write_dotenv FRONTEND_IMAGE "$CI_REGISTRY_IMAGE/frontend:$CI_COMMIT_SHA"
write_dotenv ALLOWED_ORIGINS "$allowed_origins"
write_dotenv GOOGLE_CLIENT_ID "${GOOGLE_CLIENT_ID:-}"
write_dotenv SESSION_HOURS "${SESSION_HOURS:-24}"
write_dotenv CLOUDFLARE_ACCESS_TEAM_DOMAIN "$CLOUDFLARE_ACCESS_TEAM_DOMAIN"
write_dotenv CLOUDFLARE_ACCESS_AUDIENCE "$CLOUDFLARE_ACCESS_AUDIENCE"
write_dotenv BACKUP_HOST_PATH "$backup_host_path"
write_dotenv DATA_LOAD_HOST_PATH "$data_load_host_path"
write_dotenv ADMIN_LISTEN_ADDRESS "$admin_listen_address"
write_dotenv ADMIN_SERVICE_TOKEN "$admin_service_token"
write_dotenv DATA_LOAD_STAGING_ROOT "$data_load_staging_root"
write_dotenv FRONTEND_HOST_PORT "$frontend_host_port"

: >"$registry_env_file"
write_shell_assignment CI_REGISTRY "$CI_REGISTRY"
write_shell_assignment CI_REGISTRY_USER "$CI_REGISTRY_USER"
write_shell_assignment CI_REGISTRY_PASSWORD "$CI_REGISTRY_PASSWORD"

ssh_target="$DEPLOY_USER@$DEPLOY_HOST"

ssh -p "$deploy_port" "$ssh_target" "install -d -m 700 '$remote_dir'"
scp -P "$deploy_port" docker-compose.yml "$ssh_target:$remote_dir/docker-compose.yml"
scp -P "$deploy_port" docker-compose.deploy.yml "$ssh_target:$remote_dir/docker-compose.deploy.yml"
scp -P "$deploy_port" "$deploy_env_file" "$ssh_target:$remote_dir/deploy.env"
scp -P "$deploy_port" "$registry_env_file" "$ssh_target:$remote_dir/registry.env"

ssh -p "$deploy_port" "$ssh_target" "
  set -eu
  umask 077
  cd '$remote_dir'
  chmod 600 deploy.env registry.env
  trap 'rm -f registry.env' EXIT
  set -a
  . ./registry.env
  set +a
  printf '%s' \"\$CI_REGISTRY_PASSWORD\" | docker login -u \"\$CI_REGISTRY_USER\" --password-stdin \"\$CI_REGISTRY\"
  compose='docker compose --env-file deploy.env -f docker-compose.yml -f docker-compose.deploy.yml'
  \$compose config >/dev/null
  \$compose pull
  \$compose run --rm --no-deps --user 0:0 --entrypoint sh api \
    -c 'chown 10001:10001 /var/lib/checkbook/backups /var/lib/checkbook/data-loads && chmod 700 /var/lib/checkbook/backups /var/lib/checkbook/data-loads'
  \$compose up -d postgres
  backup_dir='$remote_dir/predeploy-backups'
  install -d -m 700 \"\$backup_dir\"
  backup_file=\"\$backup_dir/checkbook-\$(date -u +%Y%m%dT%H%M%SZ).dump\"
  if ! \$compose exec -T postgres sh -c \
    'PGPASSWORD="\$POSTGRES_PASSWORD" pg_dump --format=custom --username="\$POSTGRES_USER" --dbname="\$POSTGRES_DB"' \
    >\"\$backup_file\"; then
    rm -f \"\$backup_file\"
    exit 1
  fi
  chmod 600 \"\$backup_file\"
  echo \"Pre-deployment database backup: \$backup_file\"
  \$compose run --rm migrate
  \$compose run --rm bootstrap
  \$compose up -d --remove-orphans api frontend cloudflared
  for attempt in \$(seq 1 30); do
    if \$compose exec -T api curl --fail --silent http://127.0.0.1:8000/health/ready >/dev/null; then
      break
    fi
    if [ \"\$attempt\" -eq 30 ]; then
      \$compose logs api migrate
      exit 1
    fi
    sleep 2
  done
  # Reclaim disk from images no longer backing a running container (old SHA-tagged
  # api/frontend builds pile up on this host across deploys). Runs after the new
  # stack is up so nothing in-use is removed. Non-fatal if it fails.
  docker image prune -af >/dev/null 2>&1 || true
"
