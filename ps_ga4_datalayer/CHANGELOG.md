# Changelog

## 1.0.5

Fixes a batch of event triggers that were written against *assumed*
PrestaShop contracts. Each is now verified against upstream source.

- Fix: **`view_item` never fired on Quick View.** The Classic theme emits
  `clickQuickView` with the DOM *element* as its payload (`listing.js` reads
  `elm.dataset.idProduct`); the handler treated it as `{id_product: ...}`,
  resolved nothing and returned early.
- Fix: **`remove_from_cart` never fired from the cart page.** `updateCart`
  passes the clicked element's raw `dataset`, so `reason.linkAction` is
  `delete-from-cart` (per `cart-detailed-product-line.tpl`), but the handler
  only matched `delete`.
- Fix: **`view_item_variants` fired twice per combination change.**
  `updateProduct` (theme requests a refresh) and `updatedProduct` (core
  reports completion) are two halves of one interaction, not aliases. Now
  only the completion event is used - which is also the one carrying
  product data.
- Fix: **`apply_voucher` never fired.** The Classic theme's voucher link is
  `data-link-action="add-voucher"`; none of the three spellings previously
  matched.
- Fix: **`newsletter_signup` never fired.** `ps_emailsubscription` submits a
  plain `<form method="post">` causing a full page reload, so waiting for a
  DOM mutation after submit could never work. Detected at page load instead,
  via `.notification-success` (not `.alert-success`) in the newsletter
  block. Error responses are correctly not counted.
- Fix: **`out_of_stock_alert` never fired.** `ps_emailalerts` renders no
  `<form>` at all - it is a `.js-mailalert-add` button posting by AJAX - so
  a `submit` listener could never match. Now tracks the button click and
  waits for the success article in `.js-mailalert-alerts`.
- Fix: **`review_submitted` never fired.** `productcomments` signals success
  by opening the `#product-comment-posted-modal` modal, not by rendering an
  `.alert-success`.
- Fix: **`share` reported `method: "unknown"`.** `ps_sharebuttons` puts the
  network name on the `<li>`, not the `<a>`.
- Fix: **`login` could fire for a visitor who was not logged in** (e.g. on
  arriving at the login page), if a pending flag survived from an earlier
  request. Pending login/sign_up flags are now only emitted while the
  customer is actually authenticated; otherwise they are discarded.
- Adds `tests/event-triggers-test.js` and a shared `tests/lib/dom-harness.js`
  (both run in CI). Every case encodes the real upstream contract with a
  source citation, and each fix above was re-broken to confirm the test
  fails on it.

## 1.0.4

- Fix: `add_to_wishlist` never fired with PrestaShop's official
  `blockwishlist` module. The handler looked for a `data-id-product`
  attribute, but that module renders `data-product-id` (note the word
  order) on its `.wishlist-button` wrapper, so the handler bailed out
  before pushing anything.
- Improvement: wishlist tracking now subscribes to `blockwishlist`'s own
  Vue event bus, which it exposes as `window.WishlistEventBus` after
  emitting `wishlistEventBusInit` on the PrestaShop bus. Its
  `addedToWishlist` event is the only truthful signal - a raw click on the
  heart is not an add, because a logged-out visitor gets the login modal,
  a logged-in visitor can still cancel the list-picker modal, and clicking
  an already-filled heart *removes* the product. The previous click-based
  approach would have over-counted all three.
- The click handler is retained as a fallback for themes/modules that
  render a plain wishlist link, and now accepts `data-product-id`,
  `data-id-product` (on the element or any ancestor) or the current product
  page id. It disables itself when the official bus is active, so the two
  paths can never double-count.
- Adds `tests/wishlist-datalayer-test.js` (run in CI), which reproduces
  `blockwishlist`'s real markup and event contract and asserts both that a
  confirmed add fires exactly once and that a bare click does not.

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
