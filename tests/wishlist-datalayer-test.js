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

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function makeEl(tag, attrs, className) {
  const el = {
    tagName: tag.toUpperCase(),
    className: className || '',
    _attrs: Object.assign({}, attrs || {}),
    parentElement: null,
    children: [],
    textContent: '',
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    getAttribute(n) { return this.hasAttribute(n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    matches(sel) { return selectorMatches(this, sel); },
    closest(sel) {
      let node = this;
      while (node) {
        if (selectorMatches(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

/** Supports the selector forms front.js actually uses. */
function selectorMatches(el, selector) {
  if (!el || !selector) return false;
  return String(selector).split(',').some((raw) => {
    const part = raw.trim();
    if (!part) return false;
    const classes = String(el.className || '').split(/\s+/).filter(Boolean);

    // [class*="x"]
    const contains = part.match(/^\[class\*=["']([^"']+)["']\]$/);
    if (contains) return String(el.className || '').includes(contains[1]);

    // [attr]
    const attrOnly = part.match(/^\[([a-z-]+)\]$/i);
    if (attrOnly) return el.hasAttribute(attrOnly[1]);

    // .a.b / .a
    if (part.startsWith('.') && !part.includes(' ') && !part.includes('[')) {
      return part.split('.').filter(Boolean).every((c) => classes.includes(c));
    }

    // tag[attr][attr]
    const tagAttrs = part.match(/^([a-z]+)((\[[^\]]+\])+)$/i);
    if (tagAttrs) {
      if (el.tagName !== tagAttrs[1].toUpperCase()) return false;
      const names = tagAttrs[2].match(/\[([^\]=]+)(?:=[^\]]*)?\]/g) || [];
      return names.every((n) => el.hasAttribute(n.replace(/[[\]]/g, '').split('=')[0]));
    }

    // descendant "a b" - approximate via ancestor walk on the last token
    if (part.includes(' ')) {
      const tokens = part.split(/\s+/);
      const last = tokens[tokens.length - 1];
      if (!selectorMatches(el, last)) return false;
      let node = el.parentElement;
      while (node) {
        if (selectorMatches(node, tokens.slice(0, -1).join(' '))) return true;
        node = node.parentElement;
      }
      return false;
    }

    if (/^[a-z]+$/i.test(part)) return el.tagName === part.toUpperCase();
    return false;
  });
}

function buildEnvironment() {
  const listeners = {};
  const documentEl = makeEl('body');

  const document = {
    readyState: 'complete',
    body: documentEl,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    _dispatch(type, target) {
      (listeners[type] || []).forEach((fn) => fn({ type, target }));
    },
  };

  const psHandlers = {};
  const wishlistHandlers = {};

  const win = {
    document,
    dataLayer: [],
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    psGa4Config: { currency: 'EUR', trackPromotions: true, trackEngagement: true },
    psGa4ListItems: {},
    psGa4CurrentItem: null,
    prestashop: {
      on(evt, cb) { (psHandlers[evt] = psHandlers[evt] || []).push(cb); },
      emit(evt, data) { (psHandlers[evt] || []).forEach((cb) => cb(data)); },
    },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    IntersectionObserver: undefined,
  };
  win.window = win;

  /** Stand-in for blockwishlist's Vue EventBus, exposed exactly as it does. */
  const wishlistBus = {
    $on(evt, cb) { (wishlistHandlers[evt] = wishlistHandlers[evt] || []).push(cb); },
    $emit(evt, payload) { (wishlistHandlers[evt] || []).forEach((cb) => cb(payload)); },
  };

  return { win, document, wishlistBus };
}

function loadFrontJs(env) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'ps_ga4_datalayer', 'views', 'js', 'front.js'),
    'utf8'
  );
  const ctx = vm.createContext(
    Object.assign(env.win, { console, Object, Array, String, Number, Math, JSON, parseFloat, parseInt, isNaN, WeakSet, Date })
  );
  vm.runInContext(src, ctx);
}

function ga4Events(win) {
  return win.dataLayer.filter((e) => e && e.event === 'add_to_wishlist');
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
