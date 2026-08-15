# Changelog

## 1.0.3

- Fix: push `{ecommerce: null}` before every ecommerce event, as Google's
  GA4 documentation requires. GTM's data layer *merges* successive pushes
  instead of replacing them, so without this the `items` array from an
  earlier event survived into a later one - a category page pushing
  `view_item_list` with 12 items followed by a `select_item` with 1 item
  left GTM reading 12. That silently inflated item counts and, on
  `purchase`, revenue. Applied in `header.tpl`, `purchase.tpl` and
  `front.js`.
- Adds `tests/datalayer-ecommerce-clear-test.php` (run in CI), which checks
  the clear is present and correctly placed, and models GTM's recursive
  index-wise merge to prove the clear actually stops the item bleed.

## 1.0.2

**Critical fix: the storefront rendered as a completely blank page** (empty
page source) on every page, whether or not snippet injection was enabled.

- Fix: `Tools::jsonEncode()` does not exist in PrestaShop 9 (it was removed
  in the 1.7 -> 9 cleanup). It was called from `hookDisplayHeader`, i.e. on
  every single page load. Calling an undefined static method is a fatal
  `Error`, and since PrestaShop renders inside an output buffer, the buffer
  was discarded and the visitor got a blank page with empty source. Now
  uses plain `json_encode()`.
- Fix: `Tools::isEmptyOrNull()` also does not exist in PrestaShop 9. It was
  called from `GA4DataLayerFormatter::variantLabel()`, so any product page,
  cart or order involving a combination hit the same fatal. Now checks the
  `ObjectModel`'s `id` instead.
- Hardening: every hook is now wrapped in a `Throwable` guard. Analytics is
  never worth taking a shop offline for - a failure now degrades to "no
  dataLayer for this request", logged, with the page rendering normally.
  The loggers themselves are guarded too, since logging is a DB write that
  can fail.
- Hardening: rows coming back from `Cart::getProducts()` /
  `Order::getProducts()` are validated before use, so an unexpected shape
  from another module can't cause a `TypeError` under `strict_types=1`.
- Adds `tests/hook-smoke-test.php`, run in CI: it invokes every hook across
  every page type (plus malformed data) and fails if anything throws, gets
  silently swallowed, or if `displayHeader` stops emitting markup. Both
  bugs above were verified to be caught by it.

## 1.0.1

- Fix: the Head/Body snippet fields were double HTML-escaped when the Back
  Office config screen re-rendered them (PrestaShop's admin Smarty already
  escapes `HelperForm` field values once; the module was escaping them a
  second time on top of that). Snippets now display exactly as saved. The
  storefront injection itself (which reads `Configuration::get()` directly,
  bypassing the admin display code) was never affected by this bug - but if
  you saved the settings form while the garbled text was showing, re-paste
  the snippet and save once more to clear out the corrupted stored value.

## 1.0.0

Initial release.

- 12 core GA4 eCommerce funnel events (`view_item_list`, `select_item`,
  `view_item`, `add_to_cart`, `remove_from_cart`, `view_cart`,
  `begin_checkout`, `add_shipping_info`, `add_payment_info`, `purchase`,
  `view_promotion`, `select_promotion`).
- 3 extended eCommerce events (`add_to_wishlist`, `refund`,
  `view_item_variants`).
- 4 store-engagement events (`search`, `login`, `sign_up`, `share`).
- 4 PrestaShop-specific micro-conversions (`apply_voucher`,
  `out_of_stock_alert`, `newsletter_signup`, `review_submitted`).
- Back Office configuration for raw GTM head/body snippets, injection
  toggle, promotions/engagement toggles, and optional GA4 Measurement
  Protocol credentials for server-side refund tracking.
- Purchase deduplication safeguard via a per-order cookie flag.
