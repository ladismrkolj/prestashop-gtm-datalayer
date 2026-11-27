#!/bin/sh
# Prepares the running dev store for `docker compose run --rm e2e`. Safe to re-run.
set -e
cd "$(dirname "$0")"

console() { docker compose exec -T --user www-data prestashop php -d memory_limit=-1 bin/console "$@"; }

# Consent Mode v2 banner (free, open source) - what the e2e consent checks run against.
if ! docker compose exec -T prestashop test -d modules/consentflow; then
    tmp=$(mktemp -d)
    git clone -q --depth 1 https://github.com/GajewskiMarcin/ConsentFlow.git "$tmp/consentflow"
    rm -rf "$tmp/consentflow/.git"
    docker compose cp "$tmp/consentflow" prestashop:/var/www/html/modules/consentflow
    rm -rf "$tmp"
    docker compose exec -T prestashop chown -R www-data:www-data modules/consentflow
fi

# The vendor volume is created by root; PrestaShop wants to protect it on install.
docker compose exec -T prestashop chown -R www-data:www-data modules/ps_ga4_datalayer/vendor

for module in ps_ga4_datalayer consentflow; do
    console prestashop:module install "$module" || true # already installed
done
# Hummingbird disables blockwishlist on install; the wishlist check needs it.
console prestashop:module enable blockwishlist || true
# The core GA module would push its own gtag calls into the same dataLayer.
console prestashop:module disable ps_googleanalytics || true

docker compose exec -T --user www-data prestashop php < seed.php
console cache:clear >/dev/null
echo "Store seeded."
