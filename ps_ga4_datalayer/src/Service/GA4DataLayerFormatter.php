<?php

declare(strict_types=1);

namespace PsGa4DataLayer\Service;

use Cart;
use Category;
use Combination;
use Context;
use Currency;
use Manufacturer;
use Order;
use PrestaShopLogger;
use Product;
use Throwable;
use Tools;

/**
 * Converts native PrestaShop objects (Product, Cart, Order, Combination, ...)
 * into clean, GA4-compliant associative arrays.
 *
 * Design rules enforced everywhere in this class:
 *  - Every numeric value handed to the dataLayer is a real PHP float/int,
 *    never a formatted currency string (e.g. `19.99`, not `"19,99 €"`).
 *  - Every lookup is wrapped defensively: a missing/broken relation (e.g. a
 *    product deleted after the order was placed) must degrade gracefully
 *    instead of throwing a fatal error on the storefront.
 *  - The class has no knowledge of hooks, cookies, or HTTP - it only maps
 *    data. Orchestration lives in the module's main class.
 */
final class GA4DataLayerFormatter
{
    private Context $context;

    /** @var array<int, string> Per-request cache: id_manufacturer => name */
    private array $manufacturerNameCache = [];

    /** @var array<string, array<int, string>> Per-request cache: "idCategory:idLang" => path */
    private array $categoryPathCache = [];

    public function __construct(Context $context)
    {
        $this->context = $context;
    }

    /**
     * ISO 4217 currency code for the current shop context (e.g. "EUR").
     */
    public function currencyIsoCode(): string
    {
        try {
            $currency = $this->context->currency;
            if ($currency && !empty($currency->iso_code)) {
                return (string) $currency->iso_code;
            }
        } catch (Throwable $e) {
            $this->logWarning('currencyIsoCode', $e);
        }

        return 'EUR';
    }

    /**
     * Normalise any numeric-ish value (float, int, "19.99", "19,99", null)
     * into a rounded PHP float. Never returns a string.
     */
    public function toFloat(mixed $value): float
    {
        if ($value === null || $value === '') {
            return 0.0;
        }

        if (is_string($value)) {
            $value = str_replace(',', '.', trim($value));
            $value = preg_replace('/[^0-9.\-]/', '', $value) ?? '0';
        }

        return round((float) $value, 2);
    }

    /**
     * Strip tags/whitespace from any human-readable text before it reaches
     * the dataLayer (product names, category names, brand names, search
     * terms, ...). Defensive against merchant-entered HTML in back-office
     * fields.
     */
    public function clean(?string $value): string
    {
        return trim(strip_tags((string) $value));
    }

    /**
     * Build a single GA4 `item` object from a live Product object.
     * Used for the product page (view_item) and quick-view (view_item).
     *
     * @param array{price?: float, index?: int, list_id?: string, list_name?: string, quantity?: int} $context
     */
    public function productItem(Product $product, int $idProductAttribute = 0, array $context = []): array
    {
        $idLang = (int) $this->context->language->id;
        $idProduct = (int) $product->id;

        $price = $context['price'] ?? null;
        if ($price === null) {
            $price = $this->priceForProduct($idProduct, $idProductAttribute);
        }

        $item = [
            'item_id' => $this->productIdentifier($product),
            'item_name' => $this->clean($this->productName($product)),
            'affiliation' => Tools::substr($this->clean((string) (isset($this->context->shop->name) ? $this->context->shop->name : '')), 0, 255) ?: null,
            'currency' => $this->currencyIsoCode(),
            'item_brand' => $this->brandName((int) ($product->id_manufacturer ?? 0)),
            'price' => $this->toFloat($price),
            'quantity' => (int) ($context['quantity'] ?? 1),
        ];

        if ($idProductAttribute > 0) {
            $item['item_variant'] = $this->variantLabel($idProduct, $idProductAttribute, $idLang);
        }

        $item = array_merge($item, $this->categoryFields((int) ($product->id_category_default ?? 0), $idLang));

        if (isset($context['index'])) {
            $item['index'] = (int) $context['index'];
        }
        if (isset($context['list_id'])) {
            $item['item_list_id'] = (string) $context['list_id'];
        }
        if (isset($context['list_name'])) {
            $item['item_list_name'] = (string) $context['list_name'];
        }

        return array_filter($item, static fn ($value) => $value !== null);
    }

    /**
     * Build a GA4 `item` object from a normalized listing row as produced by
     * PrestaShop's `listing.products` template variable on category, search,
     * manufacturer and supplier pages.
     *
     * The exact array shape returned by the core product presenter has
     * shifted slightly between minor PrestaShop versions, so every field is
     * read defensively through {@see self::pick()} with several fallback
     * keys.
     *
     * @param array<string, mixed> $row
     */
    public function productListItem(array $row, int $index, string $listId, string $listName): array
    {
        $idProduct = (int) $this->pick($row, ['id_product', 'id'], 0);
        $idLang = (int) $this->context->language->id;

        $price = $this->pick($row, ['price_amount', 'price_tax_incl', 'price_wt', 'price'], null);
        $idCategoryDefault = (int) $this->pick($row, ['id_category_default', 'id_category'], 0);
        $idManufacturer = (int) $this->pick($row, ['id_manufacturer', 'manufacturer_id'], 0);
        $brand = $this->clean((string) $this->pick($row, ['manufacturer_name'], ''));

        $item = [
            'item_id' => (string) ($this->pick($row, ['reference'], '') ?: $idProduct),
            'item_name' => $this->clean((string) $this->pick($row, ['name'], '')),
            'currency' => $this->currencyIsoCode(),
            'item_brand' => $brand !== '' ? $brand : $this->brandName($idManufacturer),
            'price' => $this->toFloat($price),
            'quantity' => 1,
            'index' => $index,
            'item_list_id' => $listId,
            'item_list_name' => $listName,
        ];

        $item = array_merge($item, $this->categoryFields($idCategoryDefault, $idLang));

        $idProductAttribute = (int) $this->pick($row, ['id_product_attribute'], 0);
        if ($idProductAttribute > 0) {
            $item['item_variant'] = $this->variantLabel($idProduct, $idProductAttribute, $idLang);
        }

        return array_filter($item, static fn ($value) => $value !== null && $value !== '');
    }

    /**
     * Build the `items` array (+ index/list metadata) for view_item_list.
     *
     * @param array<int, array<string, mixed>> $rows
     * @return array{items: array<int, array<string, mixed>>}
     */
    public function productList(array $rows, string $listId, string $listName): array
    {
        $items = [];
        foreach (array_values($rows) as $index => $row) {
            if (!is_array($row)) {
                continue;
            }
            $items[] = $this->productListItem($row, $index, $listId, $listName);
        }

        return ['items' => $items];
    }

    /**
     * Build the ecommerce payload (value/currency/items) for a Cart.
     *
     * @return array{value: float, currency: string, items: array<int, array<string, mixed>>}
     */
    public function cartPayload(Cart $cart): array
    {
        $items = [];
        $total = 0.0;

        try {
            $rows = $cart->getProducts(true);
        } catch (Throwable $e) {
            $this->logWarning('cartPayload', $e);
            $rows = [];
        }

        if (!is_array($rows)) {
            $rows = [];
        }

        foreach (array_values($rows) as $index => $row) {
            if (!is_array($row)) {
                continue;
            }

            $qty = (int) $this->pick($row, ['cart_quantity', 'quantity'], 1);
            $price = $this->toFloat($this->pick($row, ['price_wt', 'total_wt', 'price'], 0));

            $items[] = array_merge(
                $this->productListItem($row, $index, 'cart', 'Shopping Cart'),
                ['quantity' => $qty, 'price' => $price]
            );

            $total += $price * $qty;
        }

        return [
            'value' => $this->toFloat($total),
            'currency' => $this->currencyIsoCode(),
            'items' => $items,
        ];
    }

    /**
     * Build the full `purchase` ecommerce payload from a validated Order.
     *
     * @return array{transaction_id: string, value: float, tax: float, shipping: float, currency: string, coupon: string, items: array<int, array<string, mixed>>}
     */
    public function orderPayload(Order $order): array
    {
        $items = [];
        $index = 0;

        try {
            $rows = $order->getProducts();
        } catch (Throwable $e) {
            $this->logWarning('orderPayload:getProducts', $e);
            $rows = [];
        }

        if (!is_array($rows)) {
            $rows = [];
        }

        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $idProduct = (int) $this->pick($row, ['product_id', 'id_product'], 0);
            $idProductAttribute = (int) $this->pick($row, ['product_attribute_id', 'id_product_attribute'], 0);
            $unitPrice = $this->toFloat($this->pick($row, ['unit_price_tax_incl', 'total_price_tax_incl'], 0));
            $qty = (int) $this->pick($row, ['product_quantity'], 1);
            $idCategoryDefault = (int) $this->pick($row, ['category_default', 'id_category_default'], 0);

            $item = [
                'item_id' => (string) ($this->pick($row, ['product_reference'], '') ?: $idProduct),
                'item_name' => $this->clean((string) $this->pick($row, ['product_name'], '')),
                'currency' => $this->currencyIsoCode(),
                'price' => $unitPrice,
                'quantity' => $qty,
                'index' => $index++,
            ];

            if ($idCategoryDefault > 0) {
                $item = array_merge($item, $this->categoryFields($idCategoryDefault, (int) $order->id_lang));
            }
            if ($idProductAttribute > 0) {
                $item['item_variant'] = $this->variantLabel($idProduct, $idProductAttribute, (int) $order->id_lang);
            }

            $discount = $this->toFloat($this->pick($row, ['total_refunded_tax_incl'], 0));
            if ($discount > 0.0) {
                $item['discount'] = $discount;
            }

            $items[] = array_filter($item, static fn ($value) => $value !== null && $value !== '');
        }

        $coupon = '';
        try {
            $cart = new Cart((int) $order->id_cart);
            $codes = [];
            foreach ((array) $cart->getCartRules() as $cartRule) {
                if (!empty($cartRule['code'])) {
                    $codes[] = (string) $cartRule['code'];
                }
            }
            $coupon = implode(',', $codes);
        } catch (Throwable $e) {
            $this->logWarning('orderPayload:coupon', $e);
        }

        $currencyIso = $this->currencyIsoCode();
        try {
            $currency = new Currency((int) $order->id_currency);
            if (!empty($currency->iso_code)) {
                $currencyIso = (string) $currency->iso_code;
            }
        } catch (Throwable $e) {
            $this->logWarning('orderPayload:currency', $e);
        }

        return [
            'transaction_id' => (string) $order->reference,
            'value' => $this->toFloat($order->total_paid_tax_incl),
            'tax' => $this->toFloat(((float) $order->total_paid_tax_incl) - ((float) $order->total_paid_tax_excl)),
            'shipping' => $this->toFloat($order->total_shipping_tax_incl),
            'currency' => $currencyIso,
            'coupon' => $coupon,
            'items' => $items,
        ];
    }

    /**
     * Build a `refund` payload for a full or partial credit slip, restricted
     * to the order-detail lines actually present in $qtyList.
     *
     * @param array<int, int> $qtyList id_order_detail => refunded quantity
     */
    public function refundPayload(Order $order, array $qtyList): array
    {
        $items = [];
        $value = 0.0;
        $index = 0;

        try {
            $rows = $order->getProducts();
        } catch (Throwable $e) {
            $this->logWarning('refundPayload:getProducts', $e);
            $rows = [];
        }

        if (!is_array($rows)) {
            $rows = [];
        }

        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $idOrderDetail = (int) $this->pick($row, ['id_order_detail'], 0);
            if (!isset($qtyList[$idOrderDetail]) || (int) $qtyList[$idOrderDetail] <= 0) {
                continue;
            }

            $qty = (int) $qtyList[$idOrderDetail];
            $unitPrice = $this->toFloat($this->pick($row, ['unit_price_tax_incl', 'total_price_tax_incl'], 0));

            $items[] = [
                'item_id' => (string) ($this->pick($row, ['product_reference'], '') ?: $this->pick($row, ['product_id'], '')),
                'item_name' => $this->clean((string) $this->pick($row, ['product_name'], '')),
                'currency' => $this->currencyIsoCode(),
                'price' => $unitPrice,
                'quantity' => $qty,
                'index' => $index++,
            ];

            $value += $unitPrice * $qty;
        }

        return [
            'transaction_id' => (string) $order->reference,
            'value' => $this->toFloat($value),
            'currency' => $this->currencyIsoCode(),
            'items' => $items,
        ];
    }

    /**
     * Human-readable "Color - Red, Size - L" style label for a combination.
     */
    public function variantLabel(int $idProduct, int $idProductAttribute, ?int $idLang = null): string
    {
        if ($idProductAttribute <= 0) {
            return '';
        }

        $idLang = $idLang ?? (int) $this->context->language->id;

        try {
            // NOTE: check `->id`, not Tools::isEmptyOrNull() - that helper
            // does NOT exist in PrestaShop 9 and calling it is a fatal
            // Error. An ObjectModel constructed with an unknown id simply
            // comes back with a null id, which is what's checked here.
            $combination = new Combination($idProductAttribute);
            if ((int) $combination->id > 0 && (int) $combination->id_product === $idProduct) {
                $pairs = [];
                foreach ((array) $combination->getAttributesName($idLang) as $attribute) {
                    if (is_array($attribute) && !empty($attribute['name'])) {
                        $pairs[] = (string) $attribute['name'];
                    }
                }
                if ($pairs !== []) {
                    return implode(' / ', $pairs);
                }
            }
        } catch (Throwable $e) {
            $this->logWarning('variantLabel', $e);
        }

        return '';
    }

    /**
     * Resolve `item_category` .. `item_category5` (GA4's 5-level depth) for
     * a category id, root/home category excluded.
     *
     * @return array<string, string>
     */
    public function categoryFields(int $idCategory, ?int $idLang = null): array
    {
        if ($idCategory <= 0) {
            return [];
        }

        $idLang = $idLang ?? (int) $this->context->language->id;
        $path = $this->categoryPath($idCategory, $idLang);

        $fields = [];
        $keys = ['item_category', 'item_category2', 'item_category3', 'item_category4', 'item_category5'];
        foreach ($path as $depth => $name) {
            if (!isset($keys[$depth])) {
                break;
            }
            $fields[$keys[$depth]] = $name;
        }

        return $fields;
    }

    /**
     * Top-down list of category names leading to $idCategory (root & home
     * category excluded), capped at 5 levels for GA4.
     *
     * @return array<int, string>
     */
    public function categoryPath(int $idCategory, int $idLang): array
    {
        $cacheKey = $idCategory . ':' . $idLang;
        if (isset($this->categoryPathCache[$cacheKey])) {
            return $this->categoryPathCache[$cacheKey];
        }

        $path = [];

        try {
            $rootCategoryId = (int) \Configuration::get('PS_ROOT_CATEGORY');
            $homeCategoryId = (int) \Configuration::get('PS_HOME_CATEGORY');

            $category = new Category($idCategory, $idLang);
            $chain = [];
            $guard = 0;
            while (
                $category
                && (int) $category->id > 0
                && !in_array((int) $category->id, [$rootCategoryId, $homeCategoryId], true)
                && $guard < 10
            ) {
                $chain[] = $this->clean((string) $category->name);
                if ((int) $category->id_parent <= 0) {
                    break;
                }
                $category = new Category((int) $category->id_parent, $idLang);
                ++$guard;
            }
            $path = array_slice(array_reverse($chain), 0, 5);
        } catch (Throwable $e) {
            $this->logWarning('categoryPath', $e);
        }

        $this->categoryPathCache[$cacheKey] = $path;

        return $path;
    }

    public function brandName(int $idManufacturer): ?string
    {
        if ($idManufacturer <= 0) {
            return null;
        }

        if (isset($this->manufacturerNameCache[$idManufacturer])) {
            return $this->manufacturerNameCache[$idManufacturer];
        }

        try {
            $name = Manufacturer::getNameById($idManufacturer);
            $name = $name ? $this->clean((string) $name) : null;
        } catch (Throwable $e) {
            $this->logWarning('brandName', $e);
            $name = null;
        }

        $this->manufacturerNameCache[$idManufacturer] = $name;

        return $name;
    }

    private function priceForProduct(int $idProduct, int $idProductAttribute = 0): float
    {
        try {
            $price = Product::getPriceStatic($idProduct, true, $idProductAttribute > 0 ? $idProductAttribute : null, 2);

            return (float) $price;
        } catch (Throwable $e) {
            $this->logWarning('priceForProduct', $e);

            return 0.0;
        }
    }

    private function productIdentifier(Product $product): string
    {
        $reference = (string) ($product->reference ?? '');

        return $reference !== '' ? $reference : (string) $product->id;
    }

    private function productName(Product $product): string
    {
        $name = $product->name;
        if (is_array($name)) {
            $idLang = (int) $this->context->language->id;
            $name = $name[$idLang] ?? reset($name);
        }

        return (string) $name;
    }

    /**
     * $row is deliberately untyped (`mixed`, not `array`): core methods
     * like `Cart::getProducts()`/`Order::getProducts()` are documented to
     * return arrays of arrays, but a theme/module hook can reshape a row
     * (or a row can be missing/false) in ways this class has no control
     * over. Under `strict_types=1`, handing anything but an array to an
     * `array`-typed parameter throws an uncaught TypeError - which, given
     * PrestaShop's output buffering, blanks the entire page. Accepting
     * `mixed` here and failing soft is what actually prevents that.
     *
     * @param array<int, string> $keys
     */
    private function pick(mixed $row, array $keys, mixed $default = null): mixed
    {
        if (!is_array($row)) {
            return $default;
        }

        foreach ($keys as $key) {
            if (array_key_exists($key, $row) && $row[$key] !== null && $row[$key] !== '') {
                return $row[$key];
            }
        }

        return $default;
    }

    /**
     * Logging is itself a database write and can fail. Since it runs inside
     * this class's catch blocks, it must never throw on its own.
     */
    private function logWarning(string $context, Throwable $e): void
    {
        try {
            if (class_exists(PrestaShopLogger::class)) {
                PrestaShopLogger::addLog(
                    sprintf('[ps_ga4_datalayer] GA4DataLayerFormatter::%s - %s', $context, $e->getMessage()),
                    2,
                    null,
                    'GA4DataLayerFormatter',
                    0,
                    true
                );
            }
        } catch (Throwable $loggingFailure) {
            // Deliberately empty - see the note in Ps_ga4_datalayer::logWarning().
        }
    }
}
