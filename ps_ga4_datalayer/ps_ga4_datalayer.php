<?php

declare(strict_types=1);

/**
 * GA4 DataLayer & Google Tag Manager for PrestaShop 9.
 *
 * Pushes a complete GA4 eCommerce + engagement dataLayer to Google Tag
 * Manager: the 12 core GA4 eCommerce funnel events, 3 extended eCommerce
 * events, 4 store-engagement events and 4 PrestaShop-specific
 * micro-conversions - 23 events in total.
 *
 * @author    ladismrkolj
 * @license   MIT
 */

if (!defined('_PS_VERSION_')) {
    exit;
}

if (file_exists(__DIR__ . '/vendor/autoload.php')) {
    require_once __DIR__ . '/vendor/autoload.php';
} else {
    // Composer isn't always run for hand-deployed modules - fall back to a
    // tiny PSR-4 autoloader for the module's own `src/` namespace so the
    // module keeps working out of the box.
    spl_autoload_register(static function (string $class): void {
        $prefix = 'PsGa4DataLayer\\';
        if (strncmp($prefix, $class, strlen($prefix)) !== 0) {
            return;
        }
        $relative = substr($class, strlen($prefix));
        $file = __DIR__ . '/src/' . str_replace('\\', '/', $relative) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    });
}

use PsGa4DataLayer\Service\GA4DataLayerFormatter;

class Ps_ga4_datalayer extends Module
{
    /* ---------------------------------------------------------------- *
     *  Configuration keys (exposed exactly as requested in the spec)
     * ---------------------------------------------------------------- */
    public const CONFIG_HEAD_SNIPPET = 'PS_GTM_HEAD_SNIPPET';
    public const CONFIG_BODY_SNIPPET = 'PS_GTM_BODY_SNIPPET';
    public const CONFIG_ENABLE_INJECTION = 'PS_GTM_ENABLE_INJECTION';
    public const CONFIG_TRACK_PROMOTIONS = 'PS_GTM_TRACK_PROMOTIONS';
    public const CONFIG_TRACK_ENGAGEMENT = 'PS_GTM_TRACK_ENGAGEMENT';

    /*
     * Optional extra configuration, required only to satisfy event #14
     * (`refund`) for credit slips created in the Back Office: an
     * admin-issued refund has no customer browser session to push a
     * dataLayer event into, so GA4's own recommendation applies - send it
     * server-to-server via the Measurement Protocol instead.
     */
    public const CONFIG_MP_MEASUREMENT_ID = 'PS_GTM_MP_MEASUREMENT_ID';
    public const CONFIG_MP_API_SECRET = 'PS_GTM_MP_API_SECRET';

    private const CONFIG_KEYS = [
        self::CONFIG_HEAD_SNIPPET,
        self::CONFIG_BODY_SNIPPET,
        self::CONFIG_ENABLE_INJECTION,
        self::CONFIG_TRACK_PROMOTIONS,
        self::CONFIG_TRACK_ENGAGEMENT,
        self::CONFIG_MP_MEASUREMENT_ID,
        self::CONFIG_MP_API_SECRET,
    ];

    private const HOOKS = [
        'displayHeader',
        'displayAfterBodyOpeningTag',
        'displayOrderConfirmation',
        'actionFrontControllerSetMedia',
        'actionAuthentication',
        'actionCustomerAccountAdd',
        'actionOrderSlipAdd',
    ];

    /** Cookie flag names (stored inside PrestaShop's own signed cookie jar). */
    private const COOKIE_LOGIN_PENDING = 'ga4_login_pending';
    private const COOKIE_SIGNUP_PENDING = 'ga4_signup_pending';
    private const COOKIE_ORDER_PREFIX = 'ps_ga4_order_';

    private ?GA4DataLayerFormatter $formatter = null;

    /** Set to true within the current request as soon as a fresh signup fires, to avoid also counting it as a login. */
    private bool $signupJustHappened = false;

    /** @var array<int, array<string, mixed>> id_product => GA4 item, populated while building view_item_list. */
    private array $lastListItemsMap = [];

    /** @var array<string, mixed>|null The current product-page GA4 item, populated while building view_item. */
    private ?array $lastCurrentItem = null;

    public function __construct()
    {
        $this->name = 'ps_ga4_datalayer';
        $this->tab = 'analytics_stats';
        $this->version = '1.0.0';
        $this->author = 'ladismrkolj';
        $this->need_instance = 0;
        $this->bootstrap = true;
        $this->ps_versions_compliancy = ['min' => '9.0.0', 'max' => '9.99.99'];

        parent::__construct();

        $this->displayName = $this->l('GA4 DataLayer & Google Tag Manager');
        $this->description = $this->l('Pushes a full GA4 eCommerce & engagement dataLayer to Google Tag Manager: 23 native events covering the entire PrestaShop customer journey.');
        $this->confirmUninstall = $this->l('Are you sure? All saved GTM snippets and tracking preferences will be deleted.');
    }

    /* ==================================================================
     *  Install / uninstall
     * ================================================================== */

    public function install(): bool
    {
        return parent::install()
            && $this->registerHooks()
            && $this->installDb()
            && $this->installDefaultConfiguration();
    }

    public function uninstall(): bool
    {
        foreach (self::CONFIG_KEYS as $key) {
            Configuration::deleteByName($key);
        }

        $this->uninstallDb();

        return parent::uninstall();
    }

    private function registerHooks(): bool
    {
        foreach (self::HOOKS as $hook) {
            if (!$this->registerHook($hook)) {
                return false;
            }
        }

        return true;
    }

    private function installDefaultConfiguration(): bool
    {
        return Configuration::updateValue(self::CONFIG_HEAD_SNIPPET, '', true)
            && Configuration::updateValue(self::CONFIG_BODY_SNIPPET, '', true)
            && Configuration::updateValue(self::CONFIG_ENABLE_INJECTION, 0)
            && Configuration::updateValue(self::CONFIG_TRACK_PROMOTIONS, 1)
            && Configuration::updateValue(self::CONFIG_TRACK_ENGAGEMENT, 1)
            && Configuration::updateValue(self::CONFIG_MP_MEASUREMENT_ID, '')
            && Configuration::updateValue(self::CONFIG_MP_API_SECRET, '', true);
    }

    /**
     * Tiny auxiliary table mapping id_order => the GA4 `_ga` client id seen
     * at purchase time, so a later admin-issued refund can still be
     * attributed to the right GA4 user via the Measurement Protocol.
     */
    private function installDb(): bool
    {
        $sql = 'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'ga4_order_client` (
            `id_order` INT UNSIGNED NOT NULL,
            `client_id` VARCHAR(64) NOT NULL,
            `date_add` DATETIME NOT NULL,
            PRIMARY KEY (`id_order`)
        ) ENGINE=' . _MYSQL_ENGINE_ . ' DEFAULT CHARSET=utf8mb4';

        return (bool) Db::getInstance()->execute($sql);
    }

    private function uninstallDb(): bool
    {
        return (bool) Db::getInstance()->execute('DROP TABLE IF EXISTS `' . _DB_PREFIX_ . 'ga4_order_client`');
    }

    /* ==================================================================
     *  Back Office configuration (getContent)
     * ================================================================== */

    public function getContent(): string
    {
        $output = '';

        if (Tools::isSubmit('submitPsGa4DataLayer')) {
            $output .= $this->postProcessConfiguration();
        }

        $this->context->smarty->assign([
            'ga4_module_display_name' => $this->displayName,
        ]);

        return $output
            . $this->fetch('module:' . $this->name . '/views/templates/admin/configure.tpl')
            . $this->renderForm();
    }

    private function postProcessConfiguration(): string
    {
        $headSnippet = (string) Tools::getValue(self::CONFIG_HEAD_SNIPPET);
        $bodySnippet = (string) Tools::getValue(self::CONFIG_BODY_SNIPPET);
        $mpMeasurementId = trim((string) Tools::getValue(self::CONFIG_MP_MEASUREMENT_ID));
        $mpApiSecret = trim((string) Tools::getValue(self::CONFIG_MP_API_SECRET));

        $ok = $this->updateRawHtmlValue(self::CONFIG_HEAD_SNIPPET, $headSnippet)
            && $this->updateRawHtmlValue(self::CONFIG_BODY_SNIPPET, $bodySnippet)
            && Configuration::updateValue(self::CONFIG_ENABLE_INJECTION, (int) Tools::getValue(self::CONFIG_ENABLE_INJECTION))
            && Configuration::updateValue(self::CONFIG_TRACK_PROMOTIONS, (int) Tools::getValue(self::CONFIG_TRACK_PROMOTIONS))
            && Configuration::updateValue(self::CONFIG_TRACK_ENGAGEMENT, (int) Tools::getValue(self::CONFIG_TRACK_ENGAGEMENT))
            && Configuration::updateValue(self::CONFIG_MP_MEASUREMENT_ID, $mpMeasurementId)
            && Configuration::updateValue(self::CONFIG_MP_API_SECRET, $mpApiSecret);

        return $ok
            ? $this->displayConfirmation($this->l('Settings updated successfully.'))
            : $this->displayError($this->l('Some settings could not be saved. Please try again.'));
    }

    /**
     * `Configuration::updateValue($key, $value, true)` alone is not enough
     * to guarantee a GTM `<script>` snippet survives untouched: when the
     * shop has `PS_USE_HTMLPURIFIER` enabled (PrestaShop's default), the
     * value still gets run through HTMLPurifier and script content can be
     * stripped. Temporarily disabling it around the write - then restoring
     * it - is the same safeguard used by other GTM/GA modules in the wild.
     */
    private function updateRawHtmlValue(string $key, string $value): bool
    {
        $previousPurifierState = Configuration::get('PS_USE_HTMLPURIFIER');
        Configuration::updateValue('PS_USE_HTMLPURIFIER', 0);

        $ok = Configuration::updateValue($key, $value, true);

        Configuration::updateValue('PS_USE_HTMLPURIFIER', $previousPurifierState);

        return $ok;
    }

    private function renderForm(): string
    {
        $helper = new HelperForm();
        $helper->show_toolbar = false;
        $helper->table = $this->table;
        $helper->module = $this;
        $helper->default_form_language = (int) $this->context->language->id;
        $helper->allow_employee_form_lang = (int) Configuration::get('PS_BO_ALLOW_EMPLOYEE_FORM_LANG', null, null, null, 0);
        $helper->identifier = $this->identifier;
        $helper->submit_action = 'submitPsGa4DataLayer';
        $helper->currentIndex = $this->context->link->getAdminLink('AdminModules', false)
            . '&configure=' . $this->name . '&tab_module=' . $this->tab . '&module_name=' . $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');
        $helper->tpl_vars = [
            'fields_value' => $this->getConfigFieldsValues(),
            'languages' => $this->context->controller->getLanguages(),
            'id_language' => $this->context->language->id,
        ];

        return $helper->generateForm([
            $this->getSnippetsFormDefinition(),
            $this->getMeasurementProtocolFormDefinition(),
        ]);
    }

    /** @return array<string, mixed> */
    private function getSnippetsFormDefinition(): array
    {
        return [
            'form' => [
                'legend' => [
                    'title' => $this->l('Google Tag Manager Snippets'),
                    'icon' => 'icon-code',
                ],
                'input' => [
                    [
                        'type' => 'switch',
                        'label' => $this->l('Enable snippet injection'),
                        'name' => self::CONFIG_ENABLE_INJECTION,
                        'desc' => $this->l('When disabled, neither snippet below is output on the storefront - dataLayer events still fire, but nothing sends them anywhere until this is on.'),
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'active_on', 'value' => 1, 'label' => $this->l('Enabled')],
                            ['id' => 'active_off', 'value' => 0, 'label' => $this->l('Disabled')],
                        ],
                    ],
                    [
                        'type' => 'textarea',
                        'label' => $this->l('Head snippet'),
                        'name' => self::CONFIG_HEAD_SNIPPET,
                        'desc' => $this->l('Paste the raw Google Tag Manager <script> snippet Google gives you for the <head> section. Output verbatim, right after the dataLayer is initialised.'),
                        'rows' => 8,
                        'cols' => 80,
                        'autoload_rte' => false,
                    ],
                    [
                        'type' => 'textarea',
                        'label' => $this->l('Body snippet'),
                        'name' => self::CONFIG_BODY_SNIPPET,
                        'desc' => $this->l('Paste the raw Google Tag Manager <noscript> snippet Google gives you for right after the opening <body> tag.'),
                        'rows' => 5,
                        'cols' => 80,
                        'autoload_rte' => false,
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Track promotions'),
                        'name' => self::CONFIG_TRACK_PROMOTIONS,
                        'desc' => $this->l('Fires view_promotion / select_promotion for homepage sliders and banners carrying a data-ga4-promotion-id attribute.'),
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'promo_on', 'value' => 1, 'label' => $this->l('Enabled')],
                            ['id' => 'promo_off', 'value' => 0, 'label' => $this->l('Disabled')],
                        ],
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Track engagement'),
                        'name' => self::CONFIG_TRACK_ENGAGEMENT,
                        'desc' => $this->l('Fires search, login, sign_up and share events.'),
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'engage_on', 'value' => 1, 'label' => $this->l('Enabled')],
                            ['id' => 'engage_off', 'value' => 0, 'label' => $this->l('Disabled')],
                        ],
                    ],
                ],
                'submit' => [
                    'title' => $this->l('Save'),
                ],
            ],
        ];
    }

    /** @return array<string, mixed> */
    private function getMeasurementProtocolFormDefinition(): array
    {
        return [
            'form' => [
                'legend' => [
                    'title' => $this->l('Server-side refund tracking (optional)'),
                    'icon' => 'icon-refresh',
                ],
                'description' => $this->l('Admin-issued credit slips happen outside any customer browser session, so they can never reach GTM through the page dataLayer. Fill these in to send the refund event straight to GA4 via the Measurement Protocol instead. Leave both blank to skip server-side refund tracking.'),
                'input' => [
                    [
                        'type' => 'text',
                        'label' => $this->l('GA4 Measurement ID'),
                        'name' => self::CONFIG_MP_MEASUREMENT_ID,
                        'desc' => $this->l('Format: G-XXXXXXXXXX (GA4 Admin > Data Streams > your web stream).'),
                    ],
                    [
                        'type' => 'text',
                        'label' => $this->l('Measurement Protocol API secret'),
                        'name' => self::CONFIG_MP_API_SECRET,
                        'desc' => $this->l('GA4 Admin > Data Streams > your web stream > Measurement Protocol API secrets.'),
                    ],
                ],
                'submit' => [
                    'title' => $this->l('Save'),
                ],
            ],
        ];
    }

    /** @return array<string, mixed> */
    private function getConfigFieldsValues(): array
    {
        return [
            self::CONFIG_ENABLE_INJECTION => $this->configBool(self::CONFIG_ENABLE_INJECTION),
            self::CONFIG_HEAD_SNIPPET => Tools::htmlentitiesUTF8((string) Configuration::get(self::CONFIG_HEAD_SNIPPET)),
            self::CONFIG_BODY_SNIPPET => Tools::htmlentitiesUTF8((string) Configuration::get(self::CONFIG_BODY_SNIPPET)),
            self::CONFIG_TRACK_PROMOTIONS => $this->configBool(self::CONFIG_TRACK_PROMOTIONS),
            self::CONFIG_TRACK_ENGAGEMENT => $this->configBool(self::CONFIG_TRACK_ENGAGEMENT),
            self::CONFIG_MP_MEASUREMENT_ID => (string) Configuration::get(self::CONFIG_MP_MEASUREMENT_ID),
            self::CONFIG_MP_API_SECRET => (string) Configuration::get(self::CONFIG_MP_API_SECRET),
        ];
    }

    private function configBool(string $key): bool
    {
        return (bool) (int) Configuration::get($key);
    }

    /* ==================================================================
     *  Front-end asset registration
     * ================================================================== */

    public function hookActionFrontControllerSetMedia(array $params = []): void
    {
        $controller = $this->context->controller;

        $controller->registerJavascript(
            'module-' . $this->name . '-front',
            'modules/' . $this->name . '/views/js/front.js',
            [
                'position' => 'bottom',
                'priority' => 150,
                'attribute' => 'defer',
            ]
        );

        $pageName = method_exists($controller, 'getPageName') ? $controller->getPageName() : '';

        $config = [
            'trackPromotions' => $this->configBool(self::CONFIG_TRACK_PROMOTIONS),
            'trackEngagement' => $this->configBool(self::CONFIG_TRACK_ENGAGEMENT),
            'currency' => $this->getFormatter()->currencyIsoCode(),
            'pageType' => $pageName,
        ];

        if ($pageName === 'product') {
            // NOTE: this hook fires during FrontController::init(), before
            // initContent() assigns the `product` Smarty variable - so it
            // must come from the request itself, not from Smarty.
            $productId = (int) Tools::getValue('id_product');
            if ($productId > 0) {
                $config['currentProductId'] = $productId;
            }
        }

        if (in_array($pageName, ['cart', 'order'], true) && $this->context->cart && $this->context->cart->id) {
            $config['cart'] = $this->getFormatter()->cartPayload($this->context->cart);
        }

        Media::addJsDef(['psGa4Config' => $config]);
    }

    /* ==================================================================
     *  Snippet injection (hookDisplayHeader / hookDisplayAfterBodyOpeningTag)
     * ================================================================== */

    public function hookDisplayHeader(array $params = []): string
    {
        $events = $this->buildPageLoadEvents();

        // The same items just used for view_item_list / view_item are also
        // exposed to front.js so client-driven events (select_item,
        // add_to_wishlist, add_to_cart, ...) don't need to re-fetch product
        // data: window.psGa4ListItems (keyed by id_product) and
        // window.psGa4CurrentItem (single product-page item).
        $this->context->smarty->assign([
            'ga4_enable_injection' => $this->configBool(self::CONFIG_ENABLE_INJECTION),
            'ga4_head_snippet' => (string) Configuration::get(self::CONFIG_HEAD_SNIPPET),
            'ga4_events_b64' => $this->jsonToBase64(array_values($events)),
            'ga4_list_items_b64' => $this->jsonToBase64($this->lastListItemsMap),
            'ga4_current_item_b64' => $this->jsonToBase64($this->lastCurrentItem),
        ]);

        return $this->fetch('module:' . $this->name . '/views/templates/hook/header.tpl');
    }

    public function hookDisplayAfterBodyOpeningTag(array $params = []): string
    {
        if (!$this->configBool(self::CONFIG_ENABLE_INJECTION)) {
            return '';
        }

        $snippet = (string) Configuration::get(self::CONFIG_BODY_SNIPPET);
        if (trim($snippet) === '') {
            return '';
        }

        $this->context->smarty->assign('ga4_body_snippet', $snippet);

        return $this->fetch('module:' . $this->name . '/views/templates/hook/body_open.tpl');
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function buildPageLoadEvents(): array
    {
        $events = [];
        $controller = $this->context->controller;
        $pageName = ($controller && method_exists($controller, 'getPageName')) ? $controller->getPageName() : '';

        switch ($pageName) {
            case 'category':
            case 'manufacturer':
            case 'supplier':
                $events[] = $this->buildViewItemListEvent($pageName);
                break;

            case 'search':
                if ($this->configBool(self::CONFIG_TRACK_ENGAGEMENT)) {
                    $events[] = $this->buildSearchEvent();
                }
                $events[] = $this->buildViewItemListEvent($pageName);
                break;

            case 'product':
                $events[] = $this->buildViewItemEvent();
                break;

            case 'cart':
                $events[] = $this->buildViewCartEvent();
                break;

            case 'order':
                $events[] = $this->buildBeginCheckoutEvent();
                break;
        }

        if ($this->configBool(self::CONFIG_TRACK_ENGAGEMENT)) {
            $events[] = $this->consumeCookieEvent(self::COOKIE_LOGIN_PENDING, 'login', ['method' => 'email']);
            $events[] = $this->consumeCookieEvent(self::COOKIE_SIGNUP_PENDING, 'sign_up', ['method' => 'email']);
        }

        return array_values(array_filter($events));
    }

    private function buildViewItemListEvent(string $pageName): ?array
    {
        $listing = $this->context->smarty->getTemplateVars('listing');
        $products = is_array($listing) ? ($listing['products'] ?? []) : [];

        if (!is_array($products) || $products === []) {
            return null;
        }

        [$listId, $listName] = $this->resolveListMeta($pageName);
        $payload = $this->getFormatter()->productList($products, $listId, $listName);

        if (empty($payload['items'])) {
            return null;
        }

        foreach (array_values($products) as $index => $row) {
            if (!is_array($row) || !isset($payload['items'][$index])) {
                continue;
            }
            $idProduct = (int) $this->extractId($row, ['id_product', 'id']);
            if ($idProduct > 0) {
                $this->lastListItemsMap[$idProduct] = $payload['items'][$index];
            }
        }

        return [
            'event' => 'view_item_list',
            'ecommerce' => array_merge(
                ['item_list_id' => $listId, 'item_list_name' => $listName],
                $payload
            ),
        ];
    }

    /** @return array{0: string, 1: string} */
    private function resolveListMeta(string $pageName): array
    {
        $formatter = $this->getFormatter();

        switch ($pageName) {
            case 'category':
                $category = $this->context->smarty->getTemplateVars('category');
                $id = $this->extractId($category, ['id_category', 'id']);
                $name = $formatter->clean((string) $this->extractField($category, ['name']));

                return ['category_' . $id, $name !== '' ? $name : 'Category'];

            case 'manufacturer':
                $manufacturer = $this->context->smarty->getTemplateVars('manufacturer');
                $id = $this->extractId($manufacturer, ['id_manufacturer', 'id']);
                $name = $formatter->clean((string) $this->extractField($manufacturer, ['name']));

                return ['brand_' . $id, $name !== '' ? $name : 'Brand'];

            case 'supplier':
                $supplier = $this->context->smarty->getTemplateVars('supplier');
                $id = $this->extractId($supplier, ['id_supplier', 'id']);
                $name = $formatter->clean((string) $this->extractField($supplier, ['name']));

                return ['supplier_' . $id, $name !== '' ? $name : 'Supplier'];

            case 'search':
                return ['search_results', 'Search Results'];

            default:
                return ['list', 'Product List'];
        }
    }

    /** @param array<int, string> $keys */
    private function extractId(mixed $subject, array $keys): string
    {
        $value = $this->extractField($subject, $keys);

        return $value !== null ? (string) $value : '0';
    }

    /** @param array<int, string> $keys */
    private function extractField(mixed $subject, array $keys): mixed
    {
        foreach ($keys as $key) {
            if (is_array($subject) && isset($subject[$key])) {
                return $subject[$key];
            }
            if (is_object($subject) && isset($subject->{$key})) {
                return $subject->{$key};
            }
        }

        return null;
    }

    private function buildViewItemEvent(): ?array
    {
        $product = $this->context->smarty->getTemplateVars('product');
        if ($product === null) {
            return null;
        }

        $idProduct = (int) $this->extractId($product, ['id_product', 'id']);
        if ($idProduct <= 0) {
            return null;
        }

        try {
            $productObject = new Product($idProduct, false, (int) $this->context->language->id);
        } catch (Throwable $e) {
            return null;
        }

        $idProductAttribute = (int) ($this->extractField($product, ['id_product_attribute']) ?? 0);
        $price = $this->extractField($product, ['price_amount', 'price_tax_incl', 'price_wt']);

        $formatter = $this->getFormatter();
        $item = $formatter->productItem($productObject, $idProductAttribute, [
            'price' => $price !== null ? $formatter->toFloat($price) : null,
        ]);

        $this->lastCurrentItem = $item;

        return [
            'event' => 'view_item',
            'ecommerce' => [
                'currency' => $formatter->currencyIsoCode(),
                'value' => $item['price'] ?? 0.0,
                'items' => [$item],
            ],
        ];
    }

    private function buildViewCartEvent(): ?array
    {
        $cart = $this->context->cart;
        if (!$cart || !$cart->id) {
            return null;
        }

        $payload = $this->getFormatter()->cartPayload($cart);
        if (empty($payload['items'])) {
            return null;
        }

        return ['event' => 'view_cart', 'ecommerce' => $payload];
    }

    private function buildBeginCheckoutEvent(): ?array
    {
        $cart = $this->context->cart;
        if (!$cart || !$cart->id) {
            return null;
        }

        $payload = $this->getFormatter()->cartPayload($cart);
        if (empty($payload['items'])) {
            return null;
        }

        return ['event' => 'begin_checkout', 'ecommerce' => $payload];
    }

    private function buildSearchEvent(): ?array
    {
        $searchTerm = Tools::getValue('s');
        if (!is_string($searchTerm) || trim($searchTerm) === '') {
            $searchTerm = Tools::getValue('search_query');
        }
        $searchTerm = is_string($searchTerm) ? trim($searchTerm) : '';

        if ($searchTerm === '') {
            return null;
        }

        return ['event' => 'search', 'search_term' => $this->getFormatter()->clean($searchTerm)];
    }

    private function consumeCookieEvent(string $cookieKey, string $eventName, array $extra = []): ?array
    {
        $cookie = $this->context->cookie;
        if (empty($cookie->{$cookieKey})) {
            return null;
        }

        $cookie->{$cookieKey} = 0;
        $cookie->write();

        return array_merge(['event' => $eventName], $extra);
    }

    /* ==================================================================
     *  Purchase (hookDisplayOrderConfirmation) + dedup safeguard
     * ================================================================== */

    public function hookDisplayOrderConfirmation(array $params = []): string
    {
        $order = $params['order'] ?? $params['objOrder'] ?? null;
        if (!($order instanceof Order) || !$order->id) {
            return '';
        }

        $cookieKey = self::COOKIE_ORDER_PREFIX . (int) $order->id;
        if (!empty($this->context->cookie->{$cookieKey})) {
            // Already pushed for this order - refreshing the confirmation
            // page must never send a duplicate conversion.
            return '';
        }

        $payload = $this->getFormatter()->orderPayload($order);
        if (empty($payload['items']) && $payload['value'] <= 0.0) {
            return '';
        }

        $this->context->cookie->{$cookieKey} = 1;
        $this->context->cookie->write();

        $this->persistClientIdForOrder((int) $order->id);

        $this->context->smarty->assign('ga4_purchase_b64', $this->jsonToBase64([
            'event' => 'purchase',
            'ecommerce' => $payload,
        ]));

        return $this->fetch('module:' . $this->name . '/views/templates/hook/purchase.tpl');
    }

    /* ==================================================================
     *  Login / sign-up (server-side, one-shot cookie flags)
     * ================================================================== */

    public function hookActionAuthentication(array $params = []): void
    {
        if (!$this->configBool(self::CONFIG_TRACK_ENGAGEMENT) || $this->signupJustHappened) {
            return;
        }

        $this->context->cookie->{self::COOKIE_LOGIN_PENDING} = 1;
        $this->context->cookie->write();
    }

    public function hookActionCustomerAccountAdd(array $params = []): void
    {
        $this->signupJustHappened = true;

        if (!$this->configBool(self::CONFIG_TRACK_ENGAGEMENT)) {
            return;
        }

        $this->context->cookie->{self::COOKIE_SIGNUP_PENDING} = 1;
        $this->context->cookie->{self::COOKIE_LOGIN_PENDING} = 0;
        $this->context->cookie->write();
    }

    /* ==================================================================
     *  Refund (hookActionOrderSlipAdd) -> GA4 Measurement Protocol
     * ================================================================== */

    public function hookActionOrderSlipAdd(array $params = []): void
    {
        $order = $params['order'] ?? null;
        if (!($order instanceof Order) || !$order->id) {
            return;
        }

        $qtyList = $this->extractSlipQuantities($params);
        if ($qtyList === []) {
            return;
        }

        $payload = $this->getFormatter()->refundPayload($order, $qtyList);
        if (empty($payload['items'])) {
            return;
        }

        $clientId = $this->lookupClientIdForOrder((int) $order->id);
        if ($clientId !== null) {
            $this->sendMeasurementProtocolEvent('refund', $payload, $clientId);
        }
    }

    /**
     * @param array<string, mixed> $params
     * @return array<int, int> id_order_detail => refunded quantity
     */
    private function extractSlipQuantities(array $params): array
    {
        $productList = $params['productList'] ?? $params['product_list'] ?? [];
        $qtyList = [];

        foreach ((array) $productList as $idOrderDetail => $row) {
            if (is_array($row)) {
                $qty = $row['amount'] ?? $row['quantity'] ?? $row['product_quantity'] ?? 0;
            } else {
                $qty = $row;
            }

            $qty = (int) $qty;
            if ($qty > 0) {
                $qtyList[(int) $idOrderDetail] = $qty;
            }
        }

        return $qtyList;
    }

    private function persistClientIdForOrder(int $idOrder): void
    {
        $clientId = $this->extractGaClientId();
        if ($clientId === null) {
            return;
        }

        Db::getInstance()->execute(
            'INSERT INTO `' . _DB_PREFIX_ . 'ga4_order_client` (`id_order`, `client_id`, `date_add`)
             VALUES (' . (int) $idOrder . ', \'' . pSQL($clientId) . '\', NOW())
             ON DUPLICATE KEY UPDATE `client_id` = \'' . pSQL($clientId) . '\', `date_add` = NOW()'
        );
    }

    private function lookupClientIdForOrder(int $idOrder): ?string
    {
        $row = Db::getInstance()->getRow(
            'SELECT `client_id` FROM `' . _DB_PREFIX_ . 'ga4_order_client` WHERE `id_order` = ' . (int) $idOrder
        );

        return !empty($row['client_id']) ? (string) $row['client_id'] : null;
    }

    /**
     * The GA4 `_ga` first-party cookie has the shape `GA1.2.<client_id part
     * 1>.<client_id part 2>`. Rebuilding `<part1>.<part2>` gives the actual
     * client_id GA4 expects in Measurement Protocol calls.
     */
    private function extractGaClientId(): ?string
    {
        if (empty($_COOKIE['_ga'])) {
            return null;
        }

        $parts = explode('.', (string) $_COOKIE['_ga']);
        if (count($parts) < 4) {
            return null;
        }

        return $parts[2] . '.' . $parts[3];
    }

    /**
     * @param array<string, mixed> $params
     */
    private function sendMeasurementProtocolEvent(string $eventName, array $params, string $clientId): bool
    {
        $measurementId = trim((string) Configuration::get(self::CONFIG_MP_MEASUREMENT_ID));
        $apiSecret = trim((string) Configuration::get(self::CONFIG_MP_API_SECRET));

        if ($measurementId === '' || $apiSecret === '' || $clientId === '') {
            return false;
        }

        $url = sprintf(
            'https://www.google-analytics.com/mp/collect?measurement_id=%s&api_secret=%s',
            rawurlencode($measurementId),
            rawurlencode($apiSecret)
        );

        $body = json_encode([
            'client_id' => $clientId,
            'events' => [[
                'name' => $eventName,
                'params' => $params,
            ]],
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        if ($body === false) {
            return false;
        }

        try {
            if (function_exists('curl_init')) {
                $ch = curl_init($url);
                curl_setopt_array($ch, [
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => $body,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 5,
                    CURLOPT_CONNECTTIMEOUT => 3,
                ]);
                curl_exec($ch);
                $failed = curl_errno($ch) !== 0;
                curl_close($ch);

                return !$failed;
            }

            $context = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => "Content-Type: application/json\r\n",
                    'content' => $body,
                    'timeout' => 5,
                    'ignore_errors' => true,
                ],
            ]);

            return @file_get_contents($url, false, $context) !== false;
        } catch (Throwable $e) {
            $this->logWarning('sendMeasurementProtocolEvent', $e);

            return false;
        }
    }

    /* ==================================================================
     *  Misc helpers
     * ================================================================== */

    /**
     * Base64-encodes a JSON payload for safe embedding inside an inline
     * <script> tag, decoded client-side with `JSON.parse(atob(...))`. The
     * base64 alphabet cannot contain `<`, `/`, quotes or backslashes, so -
     * unlike escaping `</script>` by hand - this is immune to script-tag
     * breakout by construction, regardless of what a product name, search
     * term or category label happens to contain.
     */
    private function jsonToBase64(mixed $data): string
    {
        return base64_encode((string) Tools::jsonEncode($data));
    }

    private function getFormatter(): GA4DataLayerFormatter
    {
        if ($this->formatter === null) {
            $this->formatter = new GA4DataLayerFormatter($this->context);
        }

        return $this->formatter;
    }

    private function logWarning(string $context, Throwable $e): void
    {
        if (class_exists(PrestaShopLogger::class)) {
            PrestaShopLogger::addLog(
                sprintf('[%s] %s - %s', $this->name, $context, $e->getMessage()),
                2,
                null,
                'Ps_ga4_datalayer',
                0,
                true
            );
        }
    }
}
