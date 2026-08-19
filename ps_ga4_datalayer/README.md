# GA4 DataLayer & Google Tag Manager for PrestaShop 9

Pushes a complete GA4 `dataLayer` to Google Tag Manager: the 12 core GA4
eCommerce funnel events, 3 extended eCommerce events, 4 store-engagement
events and 4 PrestaShop-specific micro-conversions - **23 events** covering
the entire customer journey, with GTM snippet injection managed entirely
from the Back Office (no theme edits required).

- **Platform:** PrestaShop 9.x, PHP 8.1-8.4
- **License:** MIT

## Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [The 23 events](#the-23-events)
- [First-party data (User-ID, UPD, Measurement Protocol)](#first-party-data-user-id-upd-measurement-protocol)
- [Architecture](#architecture)
- [Customizing selectors](#customizing-selectors)
- [Testing](#testing)
- [Data mapping notes & assumptions](#data-mapping-notes--assumptions)
- [Privacy](#privacy)

## Installation

1. Zip the `ps_ga4_datalayer/` folder (the zip's root must contain
   `ps_ga4_datalayer.php` directly, not an extra parent folder) or copy it
   straight into `modules/ps_ga4_datalayer/` on your server.
2. Back Office → **Modules → Module Manager** → Upload a module / search
   "GA4 DataLayer" → **Install**.
3. Optional but recommended: run `composer install --no-dev` inside the
   module folder. The module also ships a tiny built-in autoloader fallback,
   so it works without Composer too.

## Configuration

Back Office → **Modules → Module Manager → GA4 DataLayer & Google Tag
Manager → Configure**:

| Field | Purpose |
|---|---|
| **Enable snippet injection** | Master on/off switch for both snippets below. |
| **Head snippet** | Paste Google's raw `<script>...</script>` GTM snippet for `<head>`. |
| **Body snippet** | Paste Google's raw `<noscript>...</noscript>` GTM snippet for right after `<body>`. |
| **Track promotions** | Enables `view_promotion` / `select_promotion`. |
| **Track engagement** | Enables `search`, `login`, `sign_up`, `share`. |
| **Send User-ID** | Pushes `user_id` + `user_properties` for logged-in customers (cross-device stitching). On by default. |
| **Send user-provided data (hashed)** | SHA-256 hashed email/phone/name for enhanced conversions. **Off** by default - see the privacy note. |
| **GA4 Measurement ID / API secret** *(optional)* | Needed for the `refund` event - see below. |

Snippets are stored with `Configuration::updateValue(..., true)`. That flag
alone isn't quite enough on shops with `PS_USE_HTMLPURIFIER` enabled
(PrestaShop's default) - HTMLPurifier can still strip `<script>` content
from an "HTML-allowed" configuration value. The module briefly disables
`PS_USE_HTMLPURIFIER`, saves, then restores it, so the snippet is stored
exactly as pasted either way.

## The 23 events

### A. Core GA4 eCommerce funnel (12)

| # | Event | Trigger |
|---|---|---|
| 1 | `view_item_list` | Category, brand, supplier & search result pages (server-rendered) |
| 2 | `select_item` | Click on a product card in a list/grid |
| 3 | `view_item` | Product page load, and Quick View (`clickQuickView`, whose payload is a DOM element) |
| 4 | `add_to_cart` | `prestashop.on('updateCart')` with `reason.linkAction === 'add-to-cart'` |
| 5 | `remove_from_cart` | `updateCart` with `reason.linkAction === 'delete-from-cart'` |
| 6 | `view_cart` | `/cart` page load |
| 7 | `begin_checkout` | Entering the `order` (checkout) controller |
| 8 | `add_shipping_info` | `prestashop.on('updatedDeliveryForm')` |
| 9 | `add_payment_info` | Payment option selection / `prestashop.on('termsUpdated')` |
| 10 | `purchase` | `hookDisplayOrderConfirmation`, deduplicated per order |
| 11 | `view_promotion` | Banner/slide with `data-ga4-promotion-id` enters the viewport |
| 12 | `select_promotion` | Click on that same banner/slide |

### B. Extended eCommerce (3)

| # | Event | Trigger |
|---|---|---|
| 13 | `add_to_wishlist` | Confirmed add via `blockwishlist`'s `addedToWishlist` event (falls back to click for other wishlist modules) |
| 14 | `refund` | `hookActionOrderSlipAdd` (credit slip), sent server-to-server via GA4 Measurement Protocol |
| 15 | `view_item_variants` | `updatedProduct` (the completion event) on combination change |

### C. Store engagement (4)

| # | Event | Trigger |
|---|---|---|
| 16 | `search` | Search results page load, with `search_term` |
| 17 | `login` | `hookActionAuthentication` |
| 18 | `sign_up` | `hookActionCustomerAccountAdd` |
| 19 | `share` | Social share button click on the product page |

### D. PrestaShop-specific micro-conversions (4)

| # | Event | Trigger |
|---|---|---|
| 20 | `apply_voucher` | Promo code applied (`data-link-action="add-voucher"`) |
| 21 | `out_of_stock_alert` | `ps_emailalerts` button click, once the AJAX success message renders |
| 22 | `newsletter_signup` | `ps_emailsubscription` success notice detected on page load (it posts with a full reload) |
| 23 | `review_submitted` | `productcomments` confirmation modal opens |

## First-party data (User-ID, UPD, Measurement Protocol)

GA4's **Add first-party data** checklist has three items. This module
covers all three.

### 1. User-ID

With **Send User-ID** enabled, every page for a logged-in customer pushes:

```js
{
  user_id: "42",                    // PrestaShop customer ID - never an email
  user_properties: {
    logged_in: "yes",
    customer_type: "returning",     // from validated order count
    customer_group: "Customer",
    newsletter_subscriber: "yes"
  }
}
```

This is pushed **before** any event on the page, so the first event of a
session is attributed to the identified user rather than to an anonymous
one.

**GTM still needs one wiring step** - the dataLayer value does nothing on
its own:

1. Create a **Data Layer Variable** named e.g. `DLV - user_id`, with the
   data layer variable name `user_id`.
2. Open your **Google tag** (GA4 Configuration) → under *Configuration
   settings* add a row: parameter name `user_id`, value `{{DLV - user_id}}`.
3. For `user_properties`, create Data Layer Variables for the ones you
   care about (`user_properties.customer_type`, etc.) and add them under
   *User properties* on the same tag.

In GA4 itself, set **Admin → Reporting identity** to *Blended* or
*Observed* so User-ID is actually used for reporting.

### 2. User-provided data (UPD / enhanced conversions)

With **Send user-provided data** enabled, the same push also carries:

```js
user_data: {
  sha256_email_address: "…",
  sha256_phone_number:  "…",
  address: {
    sha256_first_name: "…",
    sha256_last_name:  "…",
    city: "ljubljana", postal_code: "1000", country: "si"
  }
}
```

Hashing happens **on the server** - raw values never reach the browser.
Normalisation follows Google's rules (lowercase + trim; gmail dots
stripped; phones converted to E.164 using the address country's dialling
prefix; a phone that cannot be normalised is skipped rather than sent in a
format Google would silently fail to match).

In GTM: open your Google tag → *Include user-provided data* → choose
**Manual configuration** → map the fields to Data Layer Variables reading
`user_data.sha256_email_address`, `user_data.sha256_phone_number`, etc.

> **Privacy.** This is off by default on purpose. Hashed contact data is
> still personal data under GDPR - enable it only if your privacy notice
> covers it and your consent banner gates it. Nothing is ever sent for
> anonymous visitors.

### 3. Measurement Protocol

Already covered by the `refund` support described below: fill in the
Measurement ID + API secret and admin-issued credit slips are sent
server-to-server, now carrying `user_id` so the refund joins the same GA4
user as the original purchase.

`purchase` is deliberately **not** duplicated over the Measurement
Protocol - it already fires client-side, and sending it twice would double
your reported revenue.

### Consent Mode v2

Not implemented here by design. If you run a consent banner module (e.g.
*Google Tag Manager Consent Mode Banner*), that module owns the consent
defaults, and a second module writing them would conflict. Make sure its
`gtag('consent', 'default', …)` runs **before** the GTM container loads -
see the note in *Data mapping notes & assumptions*.

## Architecture

```
ps_ga4_datalayer/
├── ps_ga4_datalayer.php              Main module class (hooks, admin config, orchestration)
├── src/Service/
│   └── GA4DataLayerFormatter.php     Product/Cart/Order/Combination -> clean GA4 arrays
├── views/js/front.js                 prestashop.on() bus listener + DOM delegation
├── views/templates/hook/             Inline <script> templates for header/body/purchase
├── views/templates/admin/            Back Office info panel
└── translations/                     Managed via Localization > Translations in the BO
```

**Server-driven events** (`view_item_list`, `view_item`, `view_cart`,
`begin_checkout`, `purchase`, `search`, `login`, `sign_up`) are computed in
PHP and pushed via an inline `<script>` in `hookDisplayHeader`/
`hookDisplayOrderConfirmation`, *before* the pasted GTM head snippet -
matching Google's own recommendation to queue ecommerce data ahead of
`gtm.js` loading.

**Client-driven events** (everything interaction-based) are handled by
`views/js/front.js`, registered through
`$this->context->controller->registerJavascript()`. It listens to
PrestaShop 9's native `prestashop.on()` bus (`updateCart`,
`updatedDeliveryForm`, `termsUpdated`, `clickQuickView`, `updateProduct`)
and falls back to DOM delegation for blocks the bus doesn't cover.

To avoid duplicate AJAX calls, `front.js` reads two small JSON bridges the
PHP side already builds for the page-load events above:
`window.psGa4ListItems` (id_product → GA4 item, from the current
`view_item_list`) and `window.psGa4CurrentItem` (the current product page's
item) - so `select_item`, `add_to_cart`, `add_to_wishlist`, etc. don't need
to re-derive price/category/brand from the DOM.

### Why `refund` needs GA4 Measurement ID/API secret

Credit slips created in the Back Office happen outside any customer browser
session - there is no page to push a `dataLayer` event into. The module
therefore stores the GA4 `_ga` client id seen at `purchase` time (in a small
`ga4_order_client` table created on install) and, when a refund is later
recorded, sends it directly to GA4 via the [Measurement
Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4).
Leave the two fields blank to skip this (all other 22 events work with zero
extra configuration).

## Customizing selectors

Several client-side events (wishlist, newsletter, back-in-stock, reviews,
promotions) depend on CSS selectors that vary between theme
versions/overrides. Rather than editing `front.js`, override any selector
by defining `window.ga4DataLayerSelectors` in your theme **before**
`front.js` runs (e.g. from a `displayHeader` hook in your own theme/module):

```html
<script>
  window.ga4DataLayerSelectors = {
    wishlistButton: '.my-theme-wishlist-btn'
  };
</script>
```

Homepage promotions (banners/slides) are opt-in by design - add
`data-ga4-promotion-id` / `data-ga4-promotion-name` to any link or slide
your theme renders:

```html
<a href="/summer-sale" data-ga4-promotion-id="summer-sale" data-ga4-promotion-name="Summer Sale">...</a>
```

Set `window.psGa4Debug = true` in the console to log every push to the
console.

## Testing

1. **Console check** - open DevTools → Console on any storefront page and
   run:
   ```js
   window.dataLayer
   ```
   You should see an array with at least one event object (e.g.
   `{event: "view_item_list", ecommerce: {...}}` on a category page).
2. **Live-watch pushes** - set `window.psGa4Debug = true` in the console,
   then browse, add to cart, apply a voucher, etc. Each push is logged as
   `[GA4 dataLayer] {...}`.
3. **Google Tag Assistant** - install the [Tag Assistant Companion
   extension](https://tagassistant.google.com/), connect it to your GTM
   container, then browse the storefront in a new tab. Tag Assistant lists
   every GTM tag fired and the dataLayer event that triggered it.
4. **GA4 DebugView** - in GTM, enable Preview mode (or add a GA4 Debug
   parameter), then watch events arrive in GA4 Admin → DebugView in near
   real time.
5. **Purchase dedup** - place a test order, confirm `purchase` fires once,
   then refresh the confirmation page and confirm it does **not** fire
   again (the cookie flag `ps_ga4_order_{id}` blocks the resend).
6. **Refund (optional)** - fill in the Measurement Protocol fields, create
   a credit slip for a test order in the Back Office, and check GA4
   DebugView/Realtime for the `refund` event (this can take a few minutes
   to appear since it bypasses GTM Preview).

## Data mapping notes & assumptions

This module targets PrestaShop 9's Classic theme conventions. A few
mappings are necessarily "best effort" because PrestaShop doesn't expose a
single stable contract for them across every theme/module version:

- **Prices**: `GA4DataLayerFormatter` uses tax-included prices
  (`Product::getPriceStatic($id, true, ...)`), matching what's normally
  displayed to B2C shoppers. Adjust `priceForProduct()` if your shop
  displays tax-excluded prices.
- **`item_id`**: uses the product `reference` (SKU) when set, otherwise
  falls back to the numeric `id_product`.
- **Listing/product/category Smarty variables** (`listing.products`,
  `product`, `category`, `manufacturer`, `supplier`): read defensively
  through several fallback keys (`price_amount`/`price_tax_incl`/`price_wt`/
  `price`, `id_category_default`/`id_category`, ...) and support both plain
  arrays and objects, since the exact shape has shifted slightly between
  PrestaShop minor versions.
- **Hook timing**: `hookDisplayHeader` reads these Smarty variables safely
  because PrestaShop evaluates `{hook h='displayHeader'}` while rendering
  the page template, i.e. *after* `initContent()` has populated them.
  `hookActionFrontControllerSetMedia`, by contrast, runs during
  `FrontController::init()` - *before* `initContent()` - so it deliberately
  reads `id_product` from the request instead of Smarty for the JS
  `currentProductId` config value.
- **Wishlist / newsletter / back-in-stock / reviews**: DOM selectors target
  the native `blockwishlist`, `blocknewsletter`, `ps_emailalerts` and
  `productcomments` modules' typical markup, with fallbacks and an override
  mechanism (see above) since custom themes frequently restyle these
  blocks.

If a mapping doesn't match your installed theme/module versions, verify the
actual markup/response shape with DevTools and adjust `front.js`'s
`SELECTORS` (via `window.ga4DataLayerSelectors`) or
`GA4DataLayerFormatter`'s field lookups accordingly - both are intentionally
centralized and commented for this.

## Privacy

- No PII is ever pushed to `window.dataLayer` in the clear. `user_id` is
  the opaque PrestaShop customer ID, never an email. Contact details reach
  the dataLayer only if you explicitly enable user-provided data, and only
  SHA-256 hashed (hashing happens server-side).
- The GTM snippets you paste are entirely your responsibility, including
  configuring Consent Mode / cookie consent inside your GTM container.
- The `refund` Measurement Protocol call only fires if you explicitly fill
  in a Measurement ID and API secret.
