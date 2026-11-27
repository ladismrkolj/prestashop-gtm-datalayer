/**
 * Event-trigger test - run with: node tests/event-triggers-test.js
 *
 * Fast, dependency-free checks of front.js against the payloads PrestaShop 9
 * really emits (captured from the Hummingbird and Classic themes). The full
 * in-browser check against a running store is local-dev/e2e/events.mjs.
 *
 *  updateCart       {reason, resp}. Add-to-cart and cart quantity changes
 *                   carry resp.cart.products (the whole cart); Hummingbird's
 *                   delete passes a raw fetch Response, with the removed line
 *                   only in reason (linkAction "delete-from-cart").
 *  clickQuickView   Classic (core.js): {dataset: {idProduct}}.
 *  clickQuickview   Hummingbird: the miniature element.
 *  updatedProduct   resp of the product refresh; also fires on quantity
 *                   changes, with the same id_product_attribute.
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

/** A presented cart row, as in prestashop.cart.products / resp.cart.products. */
function row(idProduct, idProductAttribute, quantity, extra) {
  return Object.assign(
    {
      id_product: idProduct,
      id_product_attribute: idProductAttribute,
      id_customization: null,
      quantity,
      name: `Product ${idProduct}`,
      reference: `REF-${idProduct}`,
      price_amount: 10.5,
      attributes: idProductAttribute ? { Size: 'S', Color: 'White' } : [],
    },
    extra || {}
  );
}

async function main() {
  console.log('=== cart: add from product page ===');
  {
    const env = buildEnvironment();
    env.win.prestashop.cart.products = [row(2, 0, 1)];
    loadFrontJs(env);

    env.win.prestashop.emit('updateCart', {
      reason: { idProduct: 1, idProductAttribute: 7, linkAction: 'add-to-cart' },
      resp: { quantity: 3, cart: { products: [row(2, 0, 1), row(1, 7, 3)] } },
    });

    const adds = eventsNamed(env.win, 'add_to_cart');
    check('one add_to_cart for the added line only', adds.length === 1, `got ${adds.length}`);
    if (adds.length) {
      const item = adds[0].ecommerce.items[0];
      check('quantity is the added quantity', item.quantity === 3, `quantity=${item.quantity}`);
      check('variant label from the cart row', item.item_variant === 'S / White', `item_variant=${item.item_variant}`);
      check('value = price * quantity', adds[0].ecommerce.value === 31.5, `value=${adds[0].ecommerce.value}`);
      check('item_id is the reference', item.item_id === 'REF-1');
    }
  }

  console.log('\n=== cart: quantity changes in the cart ===');
  {
    const env = buildEnvironment();
    env.win.prestashop.cart.products = [row(1, 7, 3)];
    loadFrontJs(env);

    env.win.prestashop.emit('updateCart', { reason: { productId: '1' }, resp: { cart: { products: [row(1, 7, 4)] } } });
    env.win.prestashop.emit('updateCart', { reason: { productId: '1' }, resp: { cart: { products: [row(1, 7, 2)] } } });

    const adds = eventsNamed(env.win, 'add_to_cart');
    const removes = eventsNamed(env.win, 'remove_from_cart');
    check('+1 fires add_to_cart quantity 1', adds.length === 1 && adds[0].ecommerce.items[0].quantity === 1);
    check('-2 fires remove_from_cart quantity 2', removes.length === 1 && removes[0].ecommerce.items[0].quantity === 2);
  }

  console.log('\n=== cart: Hummingbird delete (no cart in response) ===');
  {
    const env = buildEnvironment();
    env.win.prestashop.cart.products = [row(1, 7, 2), row(2, 0, 1)];
    loadFrontJs(env);

    env.win.prestashop.emit('updateCart', {
      reason: { linkAction: 'delete-from-cart', idProduct: '1', idProductAttribute: '7', idCustomization: '' },
      resp: {},
    });

    const removes = eventsNamed(env.win, 'remove_from_cart');
    check('delete fires one remove_from_cart', removes.length === 1, `got ${removes.length}`);
    if (removes.length) {
      const item = removes[0].ecommerce.items[0];
      check('removes the whole line quantity with its price', item.quantity === 2 && item.price === 10.5);
    }

    // A later refresh carrying the real cart must not report it again.
    env.win.prestashop.emit('updateCart', { reason: {}, resp: { cart: { products: [row(2, 0, 1)] } } });
    check('no duplicate after the next cart refresh', eventsNamed(env.win, 'remove_from_cart').length === 1);
  }

  console.log('\n=== quick view: both themes, once per open ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Page.listItems = { 12: { item_id: 'REF-12', item_name: 'Mug', price: 9 } };
    loadFrontJs(env);

    const miniature = makeEl('article', { 'data-id-product': '12' }, 'product-miniature js-product-miniature');
    env.win.prestashop.emit('clickQuickview', miniature);
    env.win.prestashop.emit('clickQuickView', { dataset: { idProduct: '12' } });

    const events = eventsNamed(env.win, 'view_item');
    check('one view_item when both event names fire', events.length === 1, `got ${events.length}`);
    if (events.length) {
      check('uses the server-rendered list item', events[0].ecommerce.items[0].item_name === 'Mug');
    }
  }

  console.log('\n=== view_item_variants: only on a combination change ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.currentProductId = 8;
    env.win.psGa4Page.currentItem = { item_id: 'REF-8', item_name: 'Shirt', price: 20, item_variant: 'S / White' };
    env.win.psGa4Page.idProductAttribute = 40;
    env.win.psGa4Page.variants = { 40: { item_variant: 'S / White', price: 20 }, 44: { item_variant: 'XL / Black', price: 25 } };
    loadFrontJs(env);

    env.win.prestashop.emit('updatedProduct', { id_product_attribute: 40 }); // quantity change
    env.win.prestashop.emit('updatedProduct', { id_product_attribute: 44 });
    env.win.prestashop.emit('updatedProduct', { id_product_attribute: 44 }); // quantity change

    const events = eventsNamed(env.win, 'view_item_variants');
    check('exactly one event for one combination change', events.length === 1, `got ${events.length}`);
    if (events.length) {
      const item = events[0].ecommerce.items[0];
      check('carries the new variant label and price', item.item_variant === 'XL / Black' && item.price === 25);
    }
  }

  console.log('\n=== add_payment_info: on selection only ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.cart = { currency: 'EUR', value: 10, items: [{ item_id: 'A' }] };
    loadFrontJs(env);

    env.win.prestashop.emit('termsUpdated', { isChecked: true });
    check('ticking the terms does not fire it', eventsNamed(env.win, 'add_payment_info').length === 0);

    const input = makeEl('input', { name: 'payment-option', id: 'payment-option-1' });
    input.id = 'payment-option-1';
    input.checked = true;
    const label = makeEl('label', { for: 'payment-option-1' });
    label.textContent = ' Pay by Check ';
    env.document._add(input);
    env.document._add(label);
    env.document._dispatch('change', input);
    env.document._dispatch('change', input);

    const events = eventsNamed(env.win, 'add_payment_info');
    check('one event per chosen option', events.length === 1, `got ${events.length}`);
    if (events.length) {
      check('payment_type from the option label', events[0].ecommerce.payment_type === 'Pay by Check');
      check('carries the cart items', events[0].ecommerce.items.length === 1);
    }
  }

  console.log('\n=== apply_voucher: coupon from the submitted form ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);

    const form = makeEl('form', {});
    const input = makeEl('input', { name: 'discount_name' });
    input.value = ' SUMMER10 ';
    form.appendChild(input);
    env.document._dispatch('submit', form);
    env.win.prestashop.emit('updateCart', { reason: { linkAction: 'add-voucher' }, resp: { cart: { products: [] } } });

    const events = eventsNamed(env.win, 'apply_voucher');
    check('fires once with the code', events.length === 1 && events[0].coupon === 'SUMMER10');
  }

  console.log('\n=== newsletter_signup ===');
  {
    const env = buildEnvironment();
    const block = makeEl('section', {}, 'ps-emailsubscription');
    block.appendChild(makeEl('div', {}, 'alert alert-success'));
    env.document._add(block);
    loadFrontJs(env);
    check('Hummingbird success alert on load fires it', eventsNamed(env.win, 'newsletter_signup').length === 1);
  }
  {
    const env = buildEnvironment();
    const block = makeEl('section', {}, 'ps-emailsubscription');
    block.appendChild(makeEl('div', {}, 'alert alert-danger'));
    env.document._add(block);
    loadFrontJs(env);
    check('error alert does not', eventsNamed(env.win, 'newsletter_signup').length === 0);
  }
  {
    const env = buildEnvironment();
    loadFrontJs(env);
    const block = makeEl('div', {}, 'block_newsletter');
    const form = makeEl('form', {});
    block.appendChild(form);
    env.document._add(block);
    env.document._dispatch('submit', form);
    const alert = makeEl('p', {}, 'alert alert-success block_newsletter_alert');
    alert._visible = true;
    form.appendChild(alert);
    await wait(300);
    check('Classic AJAX success alert fires it', eventsNamed(env.win, 'newsletter_signup').length === 1);
  }

  console.log('\n=== out_of_stock_alert: Hummingbird markup ===');
  {
    const env = buildEnvironment();
    loadFrontJs(env);

    const wrapper = makeEl('div', { 'data-ps-ref': 'emailalerts' }, 'ps-emailalerts');
    const button = makeEl('button', { 'data-ps-action': 'emailalerts-subscribe', 'data-ps-data': '{"id_product": "21", "id_product_attribute": "0"}' });
    const alerts = makeEl('div', { 'data-ps-target': 'emailalerts-alerts' });
    wrapper.appendChild(button);
    wrapper.appendChild(alerts);
    env.document._add(wrapper);

    env.document._dispatch('click', button);
    check('no event before the request succeeds', eventsNamed(env.win, 'out_of_stock_alert').length === 0);

    const success = makeEl('div', {}, 'alert alert-success');
    success._visible = true;
    alerts.appendChild(success);
    await wait(300);

    const events = eventsNamed(env.win, 'out_of_stock_alert');
    check('fires once the success alert shows', events.length === 1, `got ${events.length}`);
    check('product id from data-ps-data', events.length ? events[0].item_id === '21' : false);
  }

  console.log('\n=== review_submitted: Hummingbird confirmation modal ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.currentProductId = 33;
    loadFrontJs(env);

    const form = makeEl('form', { id: 'post-product-comment-form' });
    const modal = makeEl('div', { id: 'product-post-review-posted-modal' }, 'modal fade');
    env.document.body.appendChild(modal);
    env.document._dispatch('submit', form);

    modal._visible = true;
    await wait(300);

    const events = eventsNamed(env.win, 'review_submitted');
    check('fires when the confirmation modal shows', events.length === 1, `got ${events.length}`);
  }

  console.log('\n=== share: ps_sharebuttons ===');
  {
    const env = buildEnvironment();
    env.win.psGa4Config.currentProductId = 4;
    loadFrontJs(env);

    const wrap = makeEl('div', {}, 'ps-sharebuttons');
    const li = makeEl('li', {}, 'facebook');
    const a = makeEl('a', { href: 'https://www.facebook.com/sharer.php?u=x' });
    li.appendChild(a);
    wrap.appendChild(li);
    env.document._dispatch('click', a);

    const events = eventsNamed(env.win, 'share');
    check('share fires with the network from the <li>', events.length === 1 && events[0].method === 'facebook');
  }

  console.log('\n============================================');
  if (failures.length === 0) {
    console.log('RESULT: PASS - event triggers match the PrestaShop 9 contracts');
    process.exit(0);
  }
  console.log(`RESULT: FAIL (${failures.length})`);
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}

main();
