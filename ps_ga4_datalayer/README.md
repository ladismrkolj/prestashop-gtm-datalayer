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
| **Head snippet** | Paste Google's raw `<script>...</script>` GTM snippet meant for `<head>`. The module prints it at the start of `<body>` - see [Consent Mode v2](#consent-mode-v2). |
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
| 1 | `view_item_list` | Category, brand, supplier & search result pages (server-rendered); again after AJAX filtering/paging (`updateProductList`) |
| 2 | `select_item` | Click on a product card link in a list/grid |
| 3 | `view_item` | Product page load, and Quick View (`clickQuickView` in Classic, `clickQuickview` in Hummingbird) |
| 4 | `add_to_cart` | Any `updateCart` whose cart has more of a line than before: product page, quick view, listing button, cart `+` |
| 5 | `remove_from_cart` | Any `updateCart` whose cart has less of a line: cart delete, cart `-` |
| 6 | `view_cart` | `/cart` page load |
| 7 | `begin_checkout` | Entering checkout, once per cart content (not on every checkout step) |
| 8 | `add_shipping_info` | Delivery step submitted |
| 9 | `add_payment_info` | Payment option selected |
| 10 | `purchase` | `hookDisplayOrderConfirmation`, deduplicated per order; orders split by carrier are one purchase |
| 11 | `view_promotion` | Image-slider slide, or any element with `data-ga4-promotion-id`, enters the viewport |
| 12 | `select_promotion` | Click on that same slide/element |

### B. Extended eCommerce (3)

| # | Event | Trigger |
|---|---|---|
| 13 | `add_to_wishlist` | Confirmed add via `blockwishlist`'s `addedToWishlist` event (falls back to click for other wishlist modules) |
| 14 | `refund` | `hookActionOrderSlipAdd` (credit slip), sent server-to-server via GA4 Measurement Protocol |
| 15 | `view_item_variants` | `updatedProduct` when the combination changes (quantity changes are ignored) |

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
| 20 | `apply_voucher` | Promo code applied (`updateCart` with `linkAction` `add-voucher`), with the code |
| 21 | `out_of_stock_alert` | `ps_emailalerts` subscribe button, once its success message renders |
| 22 | `newsletter_signup` | `ps_emailsubscription` success message: after Hummingbird's page reload or Classic's AJAX reply |
| 23 | `review_submitted` | `productcomments` "review posted" confirmation modal opens |

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

Use any cookie-banner module that supports Google Consent Mode v2 and
prints its `gtag('consent', 'default', ...)` in `<head>` - e.g. the free,
open-source [ConsentFlow](https://github.com/GajewskiMarcin/ConsentFlow)
(enable it and its *Google Consent Mode v2* switch). Nothing else to
configure:

- This module prints the GTM loader at the start of `<body>`, so the
  banner's consent defaults in `<head>` are always queued before `gtm.js`,
  whatever order the modules are installed or hooked in.
- The banner sends `gtag('consent', 'update', ...)` when the visitor
  chooses; GTM's Google tags adjust by themselves. dataLayer events are
  always pushed - consent decides what the tags do with them, which is
  what Consent Mode is for.

This module deliberately sets no consent state of its own: two modules
writing consent defaults conflict.

## Architecture

```
ps_ga4_datalayer/
├── ps_ga4_datalayer.php              Main module class (hooks, admin config, orchestration)
├── src/Service/
│   ├── GA4DataLayerFormatter.php     Product/Cart/Order -> clean GA4 arrays
│   └── GA4UserDataBuilder.php        User-ID, user properties, hashed user data
├── upgrade/                          Version upgrade scripts
├── views/js/front.js                 Interaction events (PrestaShop event bus + DOM delegation)
├── views/templates/hook/             Inline <script> templates (body start, purchase)
├── views/templates/admin/            Back Office info panel
└── translations/                     Managed via Localization > Translations in the BO
```

**Server-driven events** (`view_item_list`, `view_item`, `view_cart`,
`begin_checkout`, `search`, `login`, `sign_up`) are computed in PHP and
pushed from `hookDisplayAfterBodyOpeningTag`, followed by the GTM loader.
That hook is called by the layout template, i.e. only for pages that are
actually rendered and after every template variable exists.
(`displayHeader` is not usable: PrestaShop builds it before listing pages
assign their products, and also on requests that only redirect, such as
the login POST.) `purchase` comes from `hookDisplayOrderConfirmation`.

**Client-driven events** (everything interaction-based) are handled by
`views/js/front.js`. Cart events come from one place: every `updateCart`
on PrestaShop's event bus is diffed against the previous cart contents
(`prestashop.cart` at page load, then each response's cart), which yields
`add_to_cart` / `remove_from_cart` with real quantities, prices and
variants from any button in any theme. The other events use the event bus
(`clickQuickView`/`clickQuickview`, `updatedProduct`, `updateProductList`,
blockwishlist's bus) or delegated DOM listeners with selectors for both
Hummingbird and Classic.

`front.js` reuses the product data PHP already built, exposed as
`window.psGa4Page`: `listItems` (id_product → GA4 item of the current
list), `currentItem` (product page item) and `variants`
(id_product_attribute → label and price), so no extra AJAX is needed.

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
promotions, checkout labels) depend on CSS selectors. Both official
PrestaShop 9 themes (Hummingbird and Classic) are covered out of the box.
For a custom theme, override any key of `SELECTORS` in `front.js` by
defining `window.ga4DataLayerSelectors` **before** `front.js` runs (e.g.
from a `displayHeader` hook in your own theme/module):

```html
<script>
  window.ga4DataLayerSelectors = {
    wishlistButton: '.my-theme-wishlist-btn'
  };
</script>
```

Slides of the image slider (`.carousel-item`) are tracked automatically.
For any other banner, add `data-ga4-promotion-id` /
`data-ga4-promotion-name` to the link or block your theme renders:

```html
<a href="/summer-sale" data-ga4-promotion-id="summer-sale" data-ga4-promotion-name="Summer Sale">...</a>
```

Set `window.psGa4Debug = true` in the console to log every push to the
console.

## Testing

0. **Automated (developers)** - the repository's `local-dev/` folder
   starts a disposable PrestaShop 9 store in Docker and runs a real
   browser through every event (`docker compose run --rm e2e`); see the
   repository README.
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

Both official PrestaShop 9 themes (Hummingbird, the default since 9.0,
and Classic) are supported. A few mappings are necessarily "best effort"
because PrestaShop doesn't expose a single stable contract for them
across every theme/module version:

- **Prices**: `GA4DataLayerFormatter` uses tax-included prices
  (`Product::getPriceStatic($id, true, ...)`), matching what's normally
  displayed to B2C shoppers. Adjust `priceForProduct()` if your shop
  displays tax-excluded prices.
- **`item_id`**: uses the product `reference` (SKU) when set, otherwise
  falls back to the numeric `id_product`.
- **Listing/product/category Smarty variables** (`listing.products`,
  `product`, `category`, `manufacturer`, `supplier`): read defensively
  through several fallback keys (`price_amount`/`price_tax_incl`/`price_wt`/
  `price`, `id_category_default`/`id_category`, ...). Listing rows are
  core lazy-array objects (`ArrayAccess`), not plain arrays.
- **`item_variant`**: attribute names in attribute-group order joined with
  ` / ` (e.g. `S / White`), identical in every event; `item_name` is
  always the catalog name without the combination.
- **Hook timing**: `hookActionFrontControllerSetMedia` runs during
  `FrontController::init()` - before `initContent()` - so it reads
  `id_product` from the request instead of Smarty for the JS
  `currentProductId` config value. Everything that needs template
  variables runs in `hookDisplayAfterBodyOpeningTag` (see Architecture);
  your theme's layout must call `{hook h='displayAfterBodyOpeningTag'}`,
  as both official themes do.
- **Wishlist / newsletter / back-in-stock / reviews**: DOM selectors target
  the native `blockwishlist`, `ps_emailsubscription`, `ps_emailalerts` and
  `productcomments` markup of both official themes, with an override
  mechanism (see above) for custom themes.
- **Combined JS (CCC)**: after updating the module, clear the cache in
  *Advanced Parameters > Performance*, or the combined bundle keeps
  serving the previous `front.js`.

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
