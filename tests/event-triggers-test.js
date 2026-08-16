/**
 * Event-trigger test - run with: node tests/event-triggers-test.js
 *
 * Covers the interaction events whose triggers were originally written
 * against ASSUMED PrestaShop contracts and turned out to be wrong. Each
 * case below encodes the real contract, cited from upstream source, so a
 * future edit that reverts to the guessed version fails here instead of in
 * production.
 *
 * Contracts asserted (all verified against upstream):
 *
 *  clickQuickView  classic-theme _dev/js/listing.js
 *                  prestashop.on('clickQuickView', (elm) => elm.dataset.idProduct)
 *                  -> payload is a DOM ELEMENT, not an object.
 *
 *  updateCart      classic-theme _dev/js/cart.js emits {reason: dataset, resp}
 *                  where `dataset` is the clicked element's DOM dataset, so
 *                  reason.linkAction mirrors data-link-action verbatim.
 *                  The cart delete link is data-link-action="delete-from-cart"
 *                  (cart-detailed-product-line.tpl), NOT "delete".
 *                  The voucher link is data-link-action="add-voucher".
 *
 *  updatedProduct  classic-theme _dev/js/product.js emits `updateProduct` to
 *                  REQUEST a refresh; core emits `updatedProduct` when the
 *                  combination has loaded. They are two halves of one
 *                  interaction - subscribing to both double-counts.
 *
 *  newsletter      ps_emailsubscription posts a plain <form method="post">
 *                  (full page reload) and renders
 *                  <p class="notification notification-success"> on the next
 *                  render. Nothing to observe post-submit.
 *
 *  mail alerts     ps_emailalerts has NO <form>: a .js-mailalert-add button
 *                  posts by AJAX and writes the result into
 *                  .js-mailalert-alerts.
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ================================================================ *
   *  view_item on Quick View
   * ================================================================ */
  console.log('=== view_item: quick view ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);

    // The theme passes the miniature ELEMENT; it reads elm.dataset.idProduct.
    const miniature = makeEl('article', { 'data-id-product': '12', 'data-id-product-attribute': '0' }, 'product-miniature js-product-miniature');

    env.win.prestashop.emit('clickQuickView', miniature);

    const events = eventsNamed(env.win, 'view_item');
    check('quick view fires view_item', events.length === 1, `got ${events.length}`);
    if (events.length) {
      check('resolves product id from the element dataset', String(events[0].ecommerce.items[0].item_id) === '12');
    }
  }

  /* ================================================================ *
   *  remove_from_cart / add_to_cart
   * ================================================================ */
  console.log('\n=== remove_from_cart: data-link-action="delete-from-cart" ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);

    env.win.prestashop.emit('updateCart', {
      reason: { linkAction: 'delete-from-cart', idProduct: '3', idProductAttribute: '0', quantity: '1' },
      resp: { cart: { products: [] } },
    });

    const removes = eventsNamed(env.win, 'remove_from_cart');
    check('delete-from-cart fires remove_from_cart', removes.length === 1, `got ${removes.length}`);
    check('and does not fire add_to_cart', eventsNamed(env.win, 'add_to_cart').length === 0);
  }

  console.log('\n=== add_to_cart still works ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);

    env.win.prestashop.emit('updateCart', {
      reason: { linkAction: 'add-to-cart', idProduct: '3', quantity: '2' },
      resp: { cart: { products: [{ id: 3, price_with_reduction: 5 }] } },
    });

    const adds = eventsNamed(env.win, 'add_to_cart');
    check('add-to-cart fires add_to_cart', adds.length === 1, `got ${adds.length}`);
    check('quantity honoured', adds.length ? adds[0].ecommerce.items[0].quantity === 2 : false);
    check('no spurious remove_from_cart', eventsNamed(env.win, 'remove_from_cart').length === 0);
  }

  console.log('\n=== update-quantity is ignored ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);
    env.win.prestashop.emit('updateCart', {
      reason: { linkAction: 'update-quantity', idProduct: '3' },
      resp: {},
    });
    check(
      'quantity updates fire neither cart event',
      eventsNamed(env.win, 'add_to_cart').length === 0 && eventsNamed(env.win, 'remove_from_cart').length === 0
    );
  }

  /* ================================================================ *
   *  view_item_variants - exactly once per combination change
   * ================================================================ */
  console.log('\n=== view_item_variants: one event per change ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.currentProductId = 8;
    loadFrontJs(env);

    // Real sequence for ONE user click on a variant.
    env.win.prestashop.emit('updateProduct', { eventType: 'updatedProductQuantity', event: {} });
    env.win.prestashop.emit('updatedProduct', {
      product: { id_product: 8, id_product_attribute: 44, price_amount: 12.5, reference: 'REF-44' },
    });

    const events = eventsNamed(env.win, 'view_item_variants');
    check('exactly one view_item_variants per change', events.length === 1, `got ${events.length} - subscribing to both updateProduct and updatedProduct double-counts`);
    if (events.length) {
      check('carries the variant price', events[0].ecommerce.items[0].price === 12.5);
    }
  }

  /* ================================================================ *
   *  apply_voucher
   * ================================================================ */
  console.log('\n=== apply_voucher: data-link-action="add-voucher" ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);

    env.win.prestashop.emit('updateCart', {
      reason: { linkAction: 'add-voucher', voucher: 'SUMMER10' },
      resp: { cart: { total_discounts: '10.00' } },
    });

    const events = eventsNamed(env.win, 'apply_voucher');
    check('add-voucher fires apply_voucher', events.length === 1, `got ${events.length}`);
    if (events.length) {
      check('carries the coupon code', events[0].coupon === 'SUMMER10');
    }
  }

  /* ================================================================ *
   *  newsletter_signup - detected at page load, not after submit
   * ================================================================ */
  console.log('\n=== newsletter_signup: full page reload ===');
  {
    const env = buildEnvironment();
    const block = makeEl('div', { id: 'blockEmailSubscription_displayFooter' }, 'email_subscription block_newsletter');
    const notice = makeEl('p', {}, 'notification notification-success');
    block.appendChild(notice);
    env.document._add(block);

    loadFrontJs(env);

    const events = eventsNamed(env.win, 'newsletter_signup');
    check('success notice on load fires newsletter_signup', events.length === 1, `got ${events.length}`);
    check('no email address in the payload', events.length ? JSON.stringify(events[0]).indexOf('@') === -1 : false);
  }

  console.log('\n=== newsletter_signup: not fired without success ===');
  {
    const env = buildEnvironment();
    const block = makeEl('div', { id: 'blockEmailSubscription_displayFooter' }, 'email_subscription block_newsletter');
    // error variant - must NOT be counted as a signup
    block.appendChild(makeEl('p', {}, 'notification notification-error'));
    env.document._add(block);

    loadFrontJs(env);

    check('error notice does not fire newsletter_signup', eventsNamed(env.win, 'newsletter_signup').length === 0);
  }

  console.log('\n=== newsletter_signup: quiet on an ordinary page ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);
    check('no newsletter block -> no event', eventsNamed(env.win, 'newsletter_signup').length === 0);
  }

  /* ================================================================ *
   *  out_of_stock_alert - button + AJAX, no <form>
   * ================================================================ */
  console.log('\n=== out_of_stock_alert: ps_emailalerts button ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.currentProductId = 21;
    loadFrontJs(env);

    const wrapper = makeEl('div', { 'data-url': '/x' }, 'js-mailalert');
    const button = makeEl('button', { 'data-product': '21', 'data-product-attribute': '0' }, 'btn js-mailalert-add');
    const alerts = makeEl('div', {}, 'js-mailalert-alerts');
    wrapper.appendChild(button);
    wrapper.appendChild(alerts);
    env.document._add(wrapper);

    env.document._dispatch('click', button);
    check('no event before the AJAX succeeds', eventsNamed(env.win, 'out_of_stock_alert').length === 0);

    // Module writes the success article into .js-mailalert-alerts.
    alerts.appendChild(makeEl('article', { 'data-alert': 'success', role: 'alert' }, 'mt-1 alert alert-success'));
    await wait(120);

    const events = eventsNamed(env.win, 'out_of_stock_alert');
    check('fires once the success article appears', events.length === 1, `got ${events.length}`);
    if (events.length) {
      check('carries the product id', String(events[0].item_id) === '21');
    }
  }

  /* ================================================================ *
   *  review_submitted - confirmation modal, not .alert-success
   * ================================================================ */
  console.log('\n=== review_submitted: productcomments modal ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.currentProductId = 33;
    loadFrontJs(env);

    const form = makeEl('form', { id: 'post-product-comment-form' });
    const modal = makeEl('div', { id: 'product-comment-posted-modal' }, 'modal fade');
    env.document._add(form);
    env.document._add(modal);

    env.document._dispatch('submit', form);
    check('no event while the modal is hidden', eventsNamed(env.win, 'review_submitted').length === 0);

    // post-comment.js calls .modal('show') -> Bootstrap adds `show`.
    modal.classList.add('show');
    modal._visible = true;
    await wait(320);

    const events = eventsNamed(env.win, 'review_submitted');
    check('fires when the confirmation modal opens', events.length === 1, `got ${events.length}`);
    if (events.length) {
      check('carries the product id', String(events[0].item_id) === '33');
    }
  }

  /* ================================================================ *
   *  share - network name lives on the <li>
   * ================================================================ */
  console.log('\n=== share: ps_sharebuttons markup ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.currentProductId = 4;
    loadFrontJs(env);

    const wrap = makeEl('div', {}, 'social-sharing');
    const ul = makeEl('ul', {});
    const li = makeEl('li', {}, 'facebook');
    const a = makeEl('a', { href: 'https://www.facebook.com/sharer.php?u=x' });
    li.appendChild(a);
    ul.appendChild(li);
    wrap.appendChild(ul);
    env.document._add(wrap);

    env.document._dispatch('click', a);

    const events = eventsNamed(env.win, 'share');
    check('share fires on a social link click', events.length === 1, `got ${events.length}`);
    if (events.length) {
      check('method taken from the <li> class', events[0].method === 'facebook', `method=${events[0].method}`);
      check('content_type is product', events[0].content_type === 'product');
    }
  }

  console.log('\n============================================');
  if (failures.length === 0) {
    console.log('RESULT: PASS - all event triggers match the real PrestaShop contracts');
    process.exit(0);
  }
  console.log(`RESULT: FAIL (${failures.length})`);
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}

main();
