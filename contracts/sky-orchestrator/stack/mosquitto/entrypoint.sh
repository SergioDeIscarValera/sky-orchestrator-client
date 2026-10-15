#!/bin/sh
# Builds the broker's password and ACL files from the environment, then hands
# over to the image's own entrypoint.
#
# Every service credential is required: a missing or weak one stops the broker
# here, before it listens (NFR-SEC-02). SO_MQTT_PASSWORD_CLOUD_CLIENT is the one
# exception, and deliberately: left empty, the Cloud API client does not exist
# and the broker refuses that username, which is the right state under
# cloud_role: builtin (ADR-0010).
#
# Passwords never reach a command line: mosquitto_passwd -U hashes the file in
# place. The files live on a tmpfs, owned by the broker's user, mode 600.
set -eu

run=/run/mosquitto
services="so-gateway so-fleet so-wayline so-bridge"

refuse() { echo "mosquitto: refusing to start: $1" >&2; exit 64; }

# The variable a username's password comes from: so-gateway -> SO_MQTT_PASSWORD_SO_GATEWAY.
password_of() {
  var="SO_MQTT_PASSWORD_$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"
  eval "printf '%s' \"\${$var:-}\""
}

# Letters and digits only: a colon or a newline would break the file format,
# and a generated secret never needs anything else.
check() {
  case "$2" in
    *[!A-Za-z0-9]*) refuse "the password for $1 must be letters and digits only" ;;
  esac
  [ "${#2}" -ge 32 ] || refuse "the password for $1 is shorter than 32 characters"
}

umask 077
plain="$run/passwd"
: > "$plain"
for user in $services; do
  password=$(password_of "$user")
  [ -n "$password" ] || refuse "no password for $user"
  check "$user" "$password"
  printf '%s:%s\n' "$user" "$password" >> "$plain"
done

password=$(password_of cloud-client)
if [ -n "$password" ]; then
  check cloud-client "$password"
  printf 'cloud-client:%s\n' "$password" >> "$plain"
  echo "mosquitto: the Cloud API client credential is set" >&2
else
  echo "mosquitto: no Cloud API client credential, the cloud-client username is refused" >&2
fi

# The health check's own credential, random per start. mosquitto_sub reads its
# options from $XDG_CONFIG_HOME/mosquitto_sub, so the password is not on the
# health check's command line either.
healthcheck=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
printf 'broker-healthcheck:%s\n' "$healthcheck" >> "$plain"
mkdir -p "$run/healthcheck"
printf -- '-u broker-healthcheck\n-P %s\n' "$healthcheck" > "$run/healthcheck/mosquitto_sub"

mosquitto_passwd -U "$plain"
cp /so/acl "$run/acl"
chown mosquitto:mosquitto "$run" "$run/passwd" "$run/acl"

exec /docker-entrypoint.sh "$@"
