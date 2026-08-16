/**
 * add_to_wishlist test - run with: node tests/wishlist-datalayer-test.js
 *
 * Reproduces PrestaShop's official `blockwishlist` module closely enough to
 * verify the module tracks it correctly. Uses a hand-rolled DOM stub (no
 * jsdom dependency) exposing only what front.js touches.
 *
 * The markup and event contract asserted here come from the real module
 * (github.com/PrestaShop/blockwishlist):
 *
 *   views/templates/hook/product/add-button.tpl
 *     <div class="wishlist-button" data-product-id="…" data-product-attribute-id="…">
 *
 *   _dev/front/js/components/Button/Button.vue
 *     renders <button class="wishlist-button-add"> INSIDE that div
 *
 *   _dev/front/js/components/EventBus/index.js
 *     window.WishlistEventBus = EventBus;
 *     prestashop.emit('wishlistEventBusInit');
 *
 *   _dev/front/js/components/ChooseList/ChooseList.vue
 *     EventBus.$emit('addedToWishlist', {detail: {productId, listId, productAttributeId}})
 *
 * Note the attribute is `data-product-id`, NOT `data-id-product` - reading
 * the wrong one was the original bug: the handler bailed out and no
 * add_to_wishlist ever reached the dataLayer.
 */

'use strict';

const {makeEl, buildEnvironment, loadFrontJs, eventsNamed} = require('./lib/dom-harness.js');

const failures = [];
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ${label.padEnd(58)} OK`);
    return;
  }
  failures.push(label + (detail ? ` (${detail})` : ''));
  console.log(`  ${label.padEnd(58)} FAIL ${detail || ''}`);
}

/* ------------------------------------------------------------------ *
 *  Minimal DOM
 * ------------------------------------------------------------------ */

function ga4Events(win) {
  return eventsNamed(win, 'add_to_wishlist');
}

/* ================================================================== *
 *  1. Official blockwishlist flow via the event bus
 * ================================================================== */

console.log('=== blockwishlist: WishlistEventBus flow ===');
{
  const env = buildEnvironment();
  loadFrontJs(env);

  // Module bundle initialises after front.js, exactly as in production.
  env.win.WishlistEventBus = env.wishlistBus;
  env.win.prestashop.emit('wishlistEventBusInit');

  // User picks a list in the modal -> module confirms the add.
  env.wishlistBus.$emit('addedToWishlist', {
    detail: { productId: 5, listId: 1, productAttributeId: 42 },
  });

  const events = ga4Events(env.win);
  check('addedToWishlist produces exactly one add_to_wishlist', events.length === 1, `got ${events.length}`);
  if (events.length) {
    const item = events[0].ecommerce.items[0];
    check('event carries the product id', String(item.item_id) === '5', `item_id=${item.item_id}`);
    check('event carries currency', events[0].ecommerce.currency === 'EUR');
    check('ecommerce cleared beforehand', env.win.dataLayer.some((e) => e && e.ecommerce === null));
  }
}

/* ================================================================== *
 *  2. Clicking the heart must NOT itself count as an add
 * ================================================================== */

console.log('\n=== blockwishlist: click alone is not an add ===');
{
  const env = buildEnvironment();
  loadFrontJs(env);
  env.win.WishlistEventBus = env.wishlistBus;
  env.win.prestashop.emit('wishlistEventBusInit');

  // Real markup: Vue button nested in the server-rendered wrapper div.
  const wrapper = makeEl('div', { 'data-product-id': '5', 'data-product-attribute-id': '42' }, 'wishlist-button');
  const button = makeEl('button', {}, 'wishlist-button-add');
  wrapper.appendChild(button);

  env.document._dispatch('click', button);

  check(
    'click does not fire add_to_wishlist when bus is active',
    ga4Events(env.win).length === 0,
    `got ${ga4Events(env.win).length} - would over-count logged-out clicks, cancelled modals and REMOVALS`
  );

  // ...and the genuine confirmation still fires exactly once.
  env.wishlistBus.$emit('addedToWishlist', { detail: { productId: 5, listId: 1, productAttributeId: 42 } });
  check('subsequent confirmation still fires once', ga4Events(env.win).length === 1);
}

/* ================================================================== *
 *  3. Fallback for non-blockwishlist themes (no bus present)
 * ================================================================== */

console.log('\n=== fallback: plain wishlist link, no event bus ===');
{
  const env = buildEnvironment();
  loadFrontJs(env);
  // No WishlistEventBus at all.

  const link = makeEl('a', { 'data-id-product': '7' }, 'js-wishlist-btn');
  env.document._dispatch('click', link);

  const events = ga4Events(env.win);
  check('click fires add_to_wishlist via fallback', events.length === 1, `got ${events.length}`);
  if (events.length) {
    check('fallback reads data-id-product', String(events[0].ecommerce.items[0].item_id) === '7');
  }
}

console.log('\n=== fallback: blockwishlist markup but bus never initialised ===');
{
  const env = buildEnvironment();
  loadFrontJs(env);

  const wrapper = makeEl('div', { 'data-product-id': '9' }, 'wishlist-button');
  const button = makeEl('button', {}, 'wishlist-button-add');
  wrapper.appendChild(button);

  env.document._dispatch('click', button);

  const events = ga4Events(env.win);
  check('fallback reads data-product-id from ancestor', events.length === 1, `got ${events.length}`);
  if (events.length) {
    check('resolves the right product id', String(events[0].ecommerce.items[0].item_id) === '9');
  }
}

console.log('\n============================================');
if (failures.length === 0) {
  console.log('RESULT: PASS - add_to_wishlist tracked via the official bus, with click fallback');
  process.exit(0);
}
console.log(`RESULT: FAIL (${failures.length})`);
failures.forEach((f) => console.log(` - ${f}`));
process.exit(1);
