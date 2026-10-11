#!/bin/sh
# Writes the console's configuration and headers from the environment, then
# serves it (FR-DEP-04, NFR-SEC-07). Like every SOC service it refuses to start
# on a configuration it cannot trust, naming every problem (ADR-0019), and never
# repeats a value it was given in its log.
set -eu

OUT=/tmp/soc-web
URL="${SOC_WEB_SUPABASE_URL:-}"
KEY="${SOC_WEB_SUPABASE_KEY:-}"
problems=""

refuse() {
    problems="${problems:+$problems,}\"$1\""
}

key_role() {
    case "$1" in
        sb_publishable_*) printf '%s' "$1" | grep -Eq '^sb_publishable_[A-Za-z0-9_-]+$' && echo anon ;;
        sb_secret_*) echo service_role ;;
        *)
            printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' || return 0
            payload=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
            case $((${#payload} % 4)) in
                2) payload="$payload==" ;;
                3) payload="$payload=" ;;
            esac
            printf '%s' "$payload" | base64 -d 2>/dev/null |
                sed -n 's/.*"role"[[:space:]]*:[[:space:]]*"\([A-Za-z_]*\)".*/\1/p'
            ;;
    esac
}

if [ -z "$URL" ]; then
    refuse "SOC_WEB_SUPABASE_URL is not set"
elif ! printf '%s' "$URL" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$'; then
    refuse "SOC_WEB_SUPABASE_URL must be an http(s) URL with no path"
fi

if [ -z "$KEY" ]; then
    refuse "SOC_WEB_SUPABASE_KEY is not set"
else
    role=$(key_role "$KEY" || true)
    case "$role" in
        anon) ;;
        service_role) refuse "SOC_WEB_SUPABASE_KEY is the service role key, which must never reach a browser (NFR-SEC-02)" ;;
        "") refuse "SOC_WEB_SUPABASE_KEY must be the public anon key (a JWT) or a publishable key" ;;
        *) refuse "SOC_WEB_SUPABASE_KEY is a key for role $role; give the public anon or publishable key" ;;
    esac
fi

if [ -n "$problems" ]; then
    printf '{"event":"configuration_refused","service":"soc-web","problems":[%s]}\n' "$problems"
    exit 2
fi

URL="${URL%/}"
SOCKETS="ws${URL#http}"
mkdir -p "$OUT"
printf '{"supabase_url":"%s","supabase_key":"%s"}\n' "$URL" "$KEY" >"$OUT/config.json"
cat >"$OUT/headers.conf" <<EOF
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' $URL $SOCKETS; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
EOF

printf '{"event":"service_started","service":"soc-web","supabase_url":"%s"}\n' "$URL"
exec nginx -g 'daemon off;'
