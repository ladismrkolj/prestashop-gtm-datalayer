<?php
// Store configuration and data the e2e test relies on. Run by seed.sh inside the container.
require '/var/www/html/config/config.inc.php';

// GTM snippet with a placeholder container (the e2e browser blocks Google anyway).
Configuration::updateValue('PS_USE_HTMLPURIFIER', 0);
Configuration::updateValue('PS_GTM_ENABLE_INJECTION', 1);
Configuration::updateValue('PS_GTM_HEAD_SNIPPET', "<!-- Google Tag Manager -->\n<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':\nnew Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],\nj=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=\n'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);\n})(window,document,'script','dataLayer','GTM-TEST000');</script>\n<!-- End Google Tag Manager -->", true);
Configuration::updateValue('PS_GTM_BODY_SNIPPET', '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-TEST000" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>', true);
Configuration::updateValue('PS_USE_HTMLPURIFIER', 1);

// ConsentFlow with Google Consent Mode v2.
Configuration::updateValue('CONSENTFLOW_ENABLED', 1);
Configuration::updateValue('CONSENTFLOW_GOOGLE_CONSENT', 1);

// Serve module JS as-is, so edits to front.js show up without clearing the combined bundle.
Configuration::updateValue('PS_JS_THEME_CACHE', 0);
Configuration::updateValue('PS_CSS_THEME_CACHE', 0);

// Reviews are posted without moderation.
Configuration::updateValue('PRODUCT_COMMENTS_MODERATE', 0);

// Voucher for apply_voucher.
if (!CartRule::getIdByCode('TEST10')) {
    $rule = new CartRule();
    $rule->name = array_fill_keys(Language::getIDs(false), 'Test 10%');
    $rule->code = 'TEST10';
    $rule->reduction_percent = 10;
    $rule->quantity = 100000;
    $rule->quantity_per_user = 100000;
    $rule->date_from = date('Y-m-d H:i:s', time() - 86400);
    $rule->date_to = date('Y-m-d H:i:s', time() + 86400 * 3650);
    $rule->active = 1;
    $rule->add();
}

// Out-of-stock product for out_of_stock_alert.
StockAvailable::setQuantity(8, 0, 0);

// Non-ASCII product name for the encoding checks.
$product = new Product(7);
$product->name[(int) Configuration::get('PS_LANG_DEFAULT')] = 'Skodelica Čokolada – Žlahtni "mug"';
$product->update();

echo "Configuration and data seeded.\n";
