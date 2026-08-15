<?php
/**
 * Hook smoke test - run with: php tests/hook-smoke-test.php
 *
 * Boots the module against minimal PrestaShop 9 stubs and actually invokes
 * every always-on hook across every page type, with both valid and
 * deliberately malformed data.
 *
 * WHY THIS EXISTS
 * ---------------
 * `php -l` only proves a file parses. It cannot catch a call to a method
 * that doesn't exist in PrestaShop 9 (e.g. `Tools::jsonEncode()`, removed
 * in the 1.7 -> 9 cleanup). That is a fatal Error at runtime, and because
 * PrestaShop renders inside an output buffer, a fatal in `displayHeader`
 * discards the buffer: the visitor gets a completely blank page with empty
 * source. That shipped once - hence this test.
 *
 * WHAT IT ASSERTS (all three matter)
 *  1. No hook throws.
 *  2. No hook *silently swallows* an error. The module now catches
 *     Throwable at every hook boundary so a bug degrades to "no analytics"
 *     instead of "no website" - which means checking only for absence-of-
 *     fatal would happily pass on a totally broken module. Anything
 *     reaching the logger fails the run.
 *  3. `displayHeader` returns non-empty markup, since it must always emit
 *     the dataLayer bootstrap regardless of the injection toggle.
 *
 * Exits non-zero on failure so CI fails loudly.
 */

define('_PS_VERSION_', '9.0.0');
define('_DB_PREFIX_', 'ps_');
define('_MYSQL_ENGINE_', 'InnoDB');

function pSQL($s, $htmlOK = false) { return addslashes((string) $s); }

class Module {
    public $name; public $tab; public $version; public $author; public $need_instance;
    public $bootstrap; public $ps_versions_compliancy; public $displayName; public $description;
    public $confirmUninstall; public $identifier = 'id_module'; public $table = 'module';
    public $context;
    public function __construct() { $this->context = Context::getContext(); }
    public function l($s, $specific = false) { return $s; }
    public function install() { return true; }
    public function uninstall() { return true; }
    public function registerHook($h, $s = null) { return true; }
    public function displayConfirmation($t) { return "OK:$t"; }
    public function displayError($t) { return "ERR:$t"; }
    public function fetch($tpl) { return "<!-- rendered $tpl -->"; }
}

class StubSmarty {
    private array $vars = [];
    public function assign($k, $v = null) {
        if (is_array($k)) { $this->vars = array_merge($this->vars, $k); } else { $this->vars[$k] = $v; }
    }
    public function getTemplateVars($k = null) { return $k === null ? $this->vars : ($this->vars[$k] ?? null); }
}

class StubCookie {
    public array $data = [];
    public function __get($k) { return $this->data[$k] ?? null; }
    public function __set($k, $v) { $this->data[$k] = $v; }
    public function __isset($k) { return isset($this->data[$k]); }
    public function write() {}
}

class StubController {
    private string $page;
    public array $registered = [];
    public function __construct(string $page) { $this->page = $page; }
    public function getPageName() { return $this->page; }
    public function registerJavascript($id, $path, $params = []) { $this->registered[] = $id; }
    public function getLanguages() { return [['id_lang' => 1, 'iso_code' => 'en', 'name' => 'English']]; }
}

class Context {
    private static ?Context $i = null;
    public $controller; public $smarty; public $cookie; public $currency; public $language; public $shop; public $cart; public $link;
    public static function getContext() { return self::$i ??= new self(); }
    public static function reset() { self::$i = null; }
}

class Configuration {
    public static array $store = [];
    public static function get($k, $idLang = null, $g = null, $s = null, $default = false) { return self::$store[$k] ?? $default; }
    public static function updateValue($k, $v, $html = false, $g = null, $s = null) { self::$store[$k] = $v; return true; }
    public static function deleteByName($k) { unset(self::$store[$k]); return true; }
}

class Tools {
    public static array $request = [];
    public static function getValue($k, $default = false) { return self::$request[$k] ?? $default; }
    public static function isSubmit($k) { return isset(self::$request[$k]); }
    public static function substr($s, $start, $len = false, $enc = 'UTF-8') { return $len === false ? mb_substr((string)$s, $start) : mb_substr((string)$s, $start, $len); }
    public static function getAdminTokenLite($tab, $ctx = null) { return 'tok'; }
}

class Media { public static array $defs = []; public static function addJsDef($d) { self::$defs = array_merge(self::$defs, $d); } }
class PrestaShopLogger { public static array $logs = []; public static function addLog($m, $sev = 1, $ec = null, $ot = null, $oi = null, $dup = false, $emp = null) { self::$logs[] = "[$sev] $m"; } }

class DbResultStub { public function execute($sql, $c = true) { return true; } public function getRow($sql, $c = true) { return false; } }
class Db { public static function getInstance($master = true) { return new DbResultStub(); } }

class ObjectModelStub { public $id = null; }
class Product extends ObjectModelStub {
    public $reference = 'SKU-1'; public $name = 'Test Product'; public $id_manufacturer = 0; public $id_category_default = 0;
    public function __construct($id = null, $full = false, $idLang = null) { $this->id = (int) $id; }
    public static function getPriceStatic($id, $tax = true, $ipa = null, $dec = 6) { return 19.99; }
}
class Category extends ObjectModelStub { public $name = 'Cat'; public $id_parent = 0; public function __construct($id = null, $idLang = null) { $this->id = (int) $id; } }
class Manufacturer extends ObjectModelStub { public static function getNameById($id) { return 'Brand'; } }
class Currency extends ObjectModelStub { public $iso_code = 'EUR'; public function __construct($id = null) { $this->id = (int) $id; } }
class Combination extends ObjectModelStub {
    public $id_product = 5;
    public function __construct($id = null) { $this->id = (int) $id; }
    public function getAttributesName($idLang) { return [['name' => 'Red']]; }
}
class Cart extends ObjectModelStub {
    public array $rows = [];
    public function __construct($id = null) { $this->id = (int) $id; }
    public function getProducts($refresh = false) { return $this->rows; }
    public function getCartRules() { return []; }
}
class Order extends ObjectModelStub {
    public $reference = 'ABC'; public $id_cart = 1; public $id_lang = 1; public $id_currency = 1;
    public $total_paid_tax_incl = 24.0; public $total_paid_tax_excl = 20.0; public $total_shipping_tax_incl = 4.0;
    public array $rows = [];
    public function __construct($id = null) { $this->id = (int) $id; }
    public function getProducts($p = false, $sp = false, $sq = false, $full = true) { return $this->rows; }
}

/* ------------------------------------------------------------------ */

$ctx = Context::getContext();
$ctx->smarty = new StubSmarty();
$ctx->cookie = new StubCookie();
$ctx->currency = new Currency(1);
$ctx->language = new class extends ObjectModelStub { public $id = 1; };
$ctx->shop = new class extends ObjectModelStub { public $name = 'My Shop'; };
$ctx->cart = null;

require_once __DIR__ . '/../ps_ga4_datalayer/ps_ga4_datalayer.php';

$failures = [];

/**
 * $expectOutput: assert the hook returned non-empty markup.
 *
 * This matters because the module now catches Throwable at every hook
 * boundary: a genuine bug (e.g. calling a method that doesn't exist in
 * PrestaShop 9) no longer crashes the page, it silently degrades to "no
 * dataLayer at all". Checking only for absence-of-fatal would therefore
 * pass on a completely broken module. So we also assert that nothing was
 * written to the logger, since the catch blocks log on the way through.
 */
$run = function (string $label, callable $fn, bool $expectOutput = false) use (&$failures) {
    $logsBefore = count(PrestaShopLogger::$logs);
    try {
        $out = $fn();
    } catch (Throwable $e) {
        $failures[] = "$label => FATAL " . get_class($e) . ': ' . $e->getMessage();
        printf("  %-52s FATAL: %s: %s\n", $label, get_class($e), $e->getMessage());
        return;
    }

    $swallowed = array_slice(PrestaShopLogger::$logs, $logsBefore);
    if ($swallowed !== []) {
        $failures[] = "$label => swallowed error: " . implode(' | ', $swallowed);
        printf("  %-52s SWALLOWED: %s\n", $label, implode(' | ', $swallowed));
        return;
    }

    $hasOutput = is_string($out) && $out !== '';
    if ($expectOutput && !$hasOutput) {
        $failures[] = "$label => expected markup, got empty string";
        printf("  %-52s EMPTY (expected markup)\n", $label);
        return;
    }

    printf("  %-52s OK%s\n", $label, $hasOutput ? ' (output)' : '');
};

$pages = ['index', 'category', 'manufacturer', 'supplier', 'search', 'product', 'cart', 'order', 'authentication'];

foreach ([false, true] as $injectionEnabled) {
    Configuration::$store = [
        'PS_GTM_ENABLE_INJECTION' => $injectionEnabled ? 1 : 0,
        'PS_GTM_TRACK_PROMOTIONS' => 1,
        'PS_GTM_TRACK_ENGAGEMENT' => 1,
        'PS_GTM_HEAD_SNIPPET' => $injectionEnabled ? '<script>/*gtm*/</script>' : '',
        'PS_GTM_BODY_SNIPPET' => $injectionEnabled ? '<noscript>x</noscript>' : '',
        'PS_ROOT_CATEGORY' => 1, 'PS_HOME_CATEGORY' => 2,
    ];

    echo "\n=== injection " . ($injectionEnabled ? 'ENABLED' : 'DISABLED') . " ===\n";

    foreach ($pages as $page) {
        $ctx->controller = new StubController($page);
        $ctx->smarty = new StubSmarty();
        Tools::$request = ['id_product' => 5, 's' => 'shoes'];

        // Populate plausible Smarty vars for the pages that read them.
        if (in_array($page, ['category', 'manufacturer', 'supplier', 'search'], true)) {
            $ctx->smarty->assign('listing', ['products' => [
                ['id_product' => 5, 'name' => 'P', 'price_amount' => 9.99, 'id_category_default' => 3, 'id_manufacturer' => 1],
            ]]);
            $ctx->smarty->assign('category', ['id_category' => 3, 'name' => 'Shoes']);
            $ctx->smarty->assign('manufacturer', ['id_manufacturer' => 1, 'name' => 'Nike']);
            $ctx->smarty->assign('supplier', ['id_supplier' => 1, 'name' => 'Sup']);
        }
        if ($page === 'product') {
            // id_product_attribute > 0 so the combination/variantLabel path
            // is genuinely exercised, not short-circuited.
            $ctx->smarty->assign('product', ['id_product' => 5, 'price_amount' => 19.99, 'id_product_attribute' => 42]);
        }
        if (in_array($page, ['cart', 'order'], true)) {
            $cart = new Cart(1);
            $cart->rows = [['id_product' => 5, 'name' => 'P', 'price_wt' => 9.99, 'cart_quantity' => 2, 'id_category_default' => 3, 'id_product_attribute' => 42]];
            $ctx->cart = $cart;
        } else {
            $ctx->cart = null;
        }

        $m = new Ps_ga4_datalayer();
        $run("[$page] actionFrontControllerSetMedia", fn () => $m->hookActionFrontControllerSetMedia([]));
        $run("[$page] displayHeader", fn () => $m->hookDisplayHeader([]), true);
        $run("[$page] displayAfterBodyOpeningTag", fn () => $m->hookDisplayAfterBodyOpeningTag([]));
    }
}

/* Hostile / malformed data: the shapes most likely to cause a TypeError. */
echo "\n=== malformed data resilience ===\n";
$ctx->controller = new StubController('cart');
$ctx->smarty = new StubSmarty();
$badCart = new Cart(1);
$badCart->rows = ['not-an-array', null, false, 42, ['id_product' => 5, 'price_wt' => 1.0, 'cart_quantity' => 1]];
$ctx->cart = $badCart;
$m = new Ps_ga4_datalayer();
$run('[cart] displayHeader w/ non-array cart rows', fn () => $m->hookDisplayHeader([]));
$run('[cart] setMedia w/ non-array cart rows', fn () => $m->hookActionFrontControllerSetMedia([]));

$ctx->controller = new StubController('category');
$ctx->smarty = new StubSmarty();
$ctx->smarty->assign('listing', ['products' => 'totally-not-a-list']);
$ctx->cart = null;
$m = new Ps_ga4_datalayer();
$run('[category] displayHeader w/ scalar listing.products', fn () => $m->hookDisplayHeader([]));

$ctx->smarty->assign('listing', ['products' => ['x', 7, null]]);
$m = new Ps_ga4_datalayer();
$run('[category] displayHeader w/ scalar product rows', fn () => $m->hookDisplayHeader([]));

// Order confirmation + refund
$ctx->controller = new StubController('order-confirmation');
$order = new Order(11);
$order->rows = [['product_id' => 5, 'product_name' => 'P', 'unit_price_tax_incl' => 10.0, 'product_quantity' => 2, 'id_order_detail' => 77]];
$m = new Ps_ga4_datalayer();
$run('displayOrderConfirmation', fn () => $m->hookDisplayOrderConfirmation(['order' => $order]));
$run('displayOrderConfirmation (repeat = dedup)', fn () => $m->hookDisplayOrderConfirmation(['order' => $order]));
$run('actionOrderSlipAdd', fn () => $m->hookActionOrderSlipAdd(['order' => $order, 'qtyList' => [77 => 1], 'productList' => [77 => ['quantity' => 1]]]));
$run('actionAuthentication', fn () => $m->hookActionAuthentication([]));
$run('actionCustomerAccountAdd', fn () => $m->hookActionCustomerAccountAdd([]));

echo "\n============================================\n";
if ($failures === []) {
    echo "RESULT: PASS - no fatals in any hook path\n";
    exit(0);
}
echo "RESULT: FAIL (" . count($failures) . ")\n";
foreach ($failures as $f) { echo " - $f\n"; }
exit(1);
