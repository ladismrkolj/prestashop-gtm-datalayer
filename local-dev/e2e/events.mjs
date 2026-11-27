// End-to-end check of every dataLayer event the module promises, against the
// running dev store (default theme). Run: `docker compose run --rm e2e`.
// Each check prints PASS/FAIL with the offending payload; exit code 1 on any FAIL.
import { mkdirSync } from 'node:fs';
import { startBrowser, since, eventsNamed, BASE } from './lib.mjs';

const OUT = '/e2e/out';
mkdirSync(OUT, { recursive: true });

const { browser, context, pushes, errors } = await startBrowser();
// GA would normally set this; the module stores its client id at purchase for MP refunds.
await context.addCookies([{ name: '_ga', value: 'GA1.1.123456789.1700000000', url: BASE }]);
const page = await context.newPage();
const results = [];
const stamp = Date.now();
const email = `e2e-${stamp}@example.com`;
const password = 'E2eTest-Passw0rd!';

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
}

async function step(name, fn) {
    const mark = pushes.length;
    try {
        await fn(() => since(pushes, mark));
    } catch (e) {
        record(name, false, `step error: ${e.message.split('\n')[0]}`);
        await page.screenshot({ path: `${OUT}/${name.replace(/\W+/g, '_')}.png`, fullPage: false }).catch(() => {});
    }
}

const short = (v) => JSON.stringify(v).slice(0, 600);

/** Asserts exactly `count` (default: at least one) `name` events and runs `check` on the first. */
function expectEvent(label, list, name, check, count) {
    const found = eventsNamed(list, name);
    if (found.length === 0) {
        record(label, false, `no "${name}" pushed; got: ${short(list.map((d) => d.event || Object.keys(d)[0]))}`);
        return null;
    }
    if (count !== undefined && found.length !== count) {
        record(label, false, `expected ${count} "${name}", got ${found.length}`);
        return found[0];
    }
    const problem = check ? check(found[0]) : null;
    record(label, !problem, problem ? `${problem}: ${short(found[0])}` : null);
    return found[0];
}

function expectNoEvent(label, list, name) {
    const found = eventsNamed(list, name);
    record(label, found.length === 0, found.length ? `unexpected ${found.length}x "${name}"` : null);
}

/** GA4 item sanity: id, name, positive price, quantity. */
function itemProblem(item, { qty } = {}) {
    if (!item) return 'missing item';
    if (!item.item_id) return 'item_id missing';
    if (!item.item_name) return 'item_name missing';
    if (!(item.price > 0)) return `price not positive (${item.price})`;
    if (qty !== undefined && item.quantity !== qty) return `quantity ${item.quantity}, expected ${qty}`;
    return null;
}

function ecommerceProblem(ev, { qty, minItems = 1 } = {}) {
    const ec = ev.ecommerce;
    if (!ec) return 'no ecommerce object';
    if (!Array.isArray(ec.items) || ec.items.length < minItems) return `items: ${ec.items && ec.items.length}`;
    for (const item of ec.items) {
        const p = itemProblem(item, { qty });
        if (p) return p;
    }
    if (ec.value !== undefined && !(ec.value > 0)) return `value not positive (${ec.value})`;
    if (ec.value !== undefined && !ec.currency) return 'currency missing';
    return null;
}

const goto = async (path) => {
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(700);
};

// ---------------------------------------------------------------- consent
await step('consent: default before GTM loader', async (got) => {
    await goto('/');
    const list = got();
    const consentIdx = list.findIndex((d) => d.gtag && d.gtag[0] === 'consent' && d.gtag[1] === 'default');
    const gtmIdx = list.findIndex((d) => d.event === 'gtm.js');
    const firstEcom = list.findIndex((d) => d.event && d.event !== 'gtm.js');
    record(
        'consent: gtag consent default precedes gtm.js',
        consentIdx !== -1 && gtmIdx !== -1 && consentIdx < gtmIdx,
        `order: ${short(list.map((d) => d.event || (d.gtag && d.gtag.slice(0, 2).join(' ')) || Object.keys(d)[0]))}`
    );
    if (firstEcom !== -1) {
        record('consent: default precedes first page event', consentIdx !== -1 && consentIdx < firstEcom, null);
    }
});

await step('consent: accept all -> consent update', async (got) => {
    await page.locator('[data-cf-action="accept"]').first().click({ timeout: 5000 });
    await page.waitForTimeout(500);
    const update = got().find((d) => d.gtag && d.gtag[0] === 'consent' && d.gtag[1] === 'update');
    record('consent: update pushed with analytics_storage granted', !!update && update.gtag[2].analytics_storage === 'granted', update ? null : 'no consent update');
});

// ---------------------------------------------------------------- home / promotions
await step('home', async (got) => {
    await goto('/');
    const list = got();
    record('user_properties pushed for guest', list.some((d) => d.user_properties && d.user_properties.logged_in === 'no'), null);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(1500);
    const promoProblem = (e) =>
        !e.ecommerce
            ? 'promotion fields not inside ecommerce'
            : !e.ecommerce.promotion_name
              ? 'promotion_name missing'
              : !(e.ecommerce.items && e.ecommerce.items.length)
                ? 'items missing'
                : null;
    expectEvent('view_promotion (home slider)', got(), 'view_promotion', promoProblem);
    const slide = page.locator('.carousel-item.active a').first();
    if (await slide.count()) {
        const mark = pushes.length;
        await slide.click({ noWaitAfter: true }).catch(() => {});
        await page.waitForTimeout(300);
        expectEvent('select_promotion (home slider click)', since(pushes, mark), 'select_promotion', promoProblem);
    } else {
        record('select_promotion (home slider click)', false, 'no clickable slide');
    }
});

// ---------------------------------------------------------------- category / select_item / quick view
await step('category', async (got) => {
    await goto('/3-clothes');
    expectEvent('view_item_list on category', got(), 'view_item_list', (e) =>
        ecommerceProblem(e) || (!e.ecommerce.item_list_name ? 'item_list_name missing' : null)
    );
    const hasListBridge = await page.evaluate(() => Object.keys((window.psGa4Page && window.psGa4Page.listItems) || {}).length);
    record('psGa4Page.listItems bridge populated on category', hasListBridge > 0, `size ${hasListBridge}`);

    // Faceted search reloads the list by AJAX.
    const mark = pushes.length;
    const facets = page.locator('[data-search-url]').locator('visible=true');
    if (!(await facets.count())) {
        // Hummingbird collapses each facet group.
        await page.getByRole('button', { name: 'Size' }).first().click();
        await page.waitForTimeout(500);
    }
    await facets.first().click();
    await page.waitForTimeout(3000);
    expectEvent('view_item_list after facet filter (AJAX)', since(pushes, mark), 'view_item_list', (e) => ecommerceProblem(e));
});

await step('quick view', async (got) => {
    await goto('/3-clothes');
    const mark = pushes.length;
    await page.locator('.js-product-miniature').first().hover();
    await page.locator('.js-product-miniature .js-quickview, .js-product-miniature .quick-view').first().click({ force: true });
    await page.waitForSelector('.modal.show, .quickview.show, [id^="quickview-modal"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    expectEvent('view_item on quick view', since(pushes, mark), 'view_item', (e) => ecommerceProblem(e));
    const qvAdd = page.locator('.modal.show [data-button-action="add-to-cart"]').first();
    if (await qvAdd.count()) {
        const mark2 = pushes.length;
        await qvAdd.click();
        await page.waitForTimeout(2500);
        expectEvent('add_to_cart from quick view', since(pushes, mark2), 'add_to_cart', (e) => ecommerceProblem(e, { qty: 1 }));
    }
});

await step('select_item', async (got) => {
    await goto('/3-clothes');
    const mark = pushes.length;
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.locator('.js-product-miniature a.product-miniature__title, .js-product-miniature .product-title a, .js-product-miniature a').first().click(),
    ]);
    expectEvent('select_item on product card click', since(pushes, mark), 'select_item', (e) =>
        ecommerceProblem(e) || (!e.ecommerce.item_list_name ? 'item_list_name missing' : null)
    );
});

// ---------------------------------------------------------------- product page
await step('product page', async (got) => {
    await goto('/1-hummingbird-printed-t-shirt.html');
    const view = expectEvent('view_item on product page', got(), 'view_item', (e) => ecommerceProblem(e));

    const mark = pushes.length;
    const sizeSelect = page.locator('select[name^="group["]').first();
    if (await sizeSelect.count()) {
        const options = await sizeSelect.locator('option').evaluateAll((os) => os.map((o) => o.value));
        await sizeSelect.selectOption(options[options.length - 1]);
    } else {
        await page.locator('input[type="radio"][name^="group["]:not(:checked)').first().check({ force: true });
    }
    await page.waitForTimeout(2500);
    const variant = expectEvent(
        'view_item_variants on combination change (exactly once)',
        since(pushes, mark),
        'view_item_variants',
        (e) => ecommerceProblem(e) || (!e.ecommerce.items[0].item_variant ? 'item_variant missing' : null),
        1
    );
    if (variant && view) {
        const changed = JSON.stringify(variant.ecommerce.items[0]) !== JSON.stringify(view.ecommerce.items[0]);
        record('view_item_variants item differs from initial view_item', changed, short(variant.ecommerce.items[0]));
    }

    const mark2 = pushes.length;
    await page.locator('#quantity_wanted').fill('3');
    await page.locator('#quantity_wanted').blur();
    await page.waitForTimeout(1200);
    await page.locator('.product__add-to-cart [data-button-action="add-to-cart"], #add-to-cart-or-refresh [data-button-action="add-to-cart"]').first().click();
    await page.waitForTimeout(2500);
    expectEvent('add_to_cart qty 3 on product page', since(pushes, mark2), 'add_to_cart', (e) => {
        const p = ecommerceProblem(e, { qty: 3 });
        if (p) return p;
        const expected = Math.round(e.ecommerce.items[0].price * 3 * 100) / 100;
        if (Math.abs(e.ecommerce.value - expected) > 0.011) return `value ${e.ecommerce.value} != price*3 ${expected}`;
        return variant && e.ecommerce.items[0].item_variant !== variant.ecommerce.items[0].item_variant
            ? `item_variant "${e.ecommerce.items[0].item_variant}" != selected "${variant.ecommerce.items[0].item_variant}"`
            : null;
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
});

await step('share', async (got) => {
    await goto('/1-hummingbird-printed-t-shirt.html');
    const mark = pushes.length;
    const popupPromise = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
    await page.locator('.ps-sharebuttons a, .social-sharing a').first().click();
    const popup = await popupPromise;
    if (popup) await popup.close();
    expectEvent('share on social button', since(pushes, mark), 'share', (e) =>
        e.method === 'unknown' || !e.method ? `method "${e.method}"` : !e.item_id ? 'item_id missing' : null
    );
});

// ---------------------------------------------------------------- search + UTF-8
await step('search', async (got) => {
    await goto('/search?s=' + encodeURIComponent('čokolada'));
    expectEvent('search with UTF-8 term', got(), 'search', (e) => (e.search_term !== 'čokolada' ? `search_term "${e.search_term}"` : null));
    await goto('/search?s=mug');
    expectEvent('view_item_list on search results', got(), 'view_item_list', (e) => ecommerceProblem(e));
});

await step('utf8 product name', async (got) => {
    await goto('/7-mug-the-adventure-begins.html');
    expectEvent('view_item item_name keeps UTF-8', got(), 'view_item', (e) => {
        const n = e.ecommerce && e.ecommerce.items && e.ecommerce.items[0].item_name;
        return n !== 'Skodelica Čokolada – Žlahtni "mug"' ? `item_name "${n}"` : null;
    });
});

// ---------------------------------------------------------------- out of stock alert (guest)
await step('out_of_stock_alert', async (got) => {
    await goto('/8-mug-today-is-a-good-day.html');
    const mark = pushes.length;
    const input = page.locator('.js-mailalert input[type="email"], [data-ps-ref="emailalerts-email"]').first();
    if (await input.count()) await input.fill(`oos-${stamp}@example.com`);
    for (const cb of await page.locator('.ps-emailalerts input[type="checkbox"], .js-mailalert input[type="checkbox"]').all()) {
        await cb.check({ force: true });
    }
    await page.locator('.js-mailalert-add, [data-ps-action="emailalerts-subscribe"]').first().click();
    await page.waitForTimeout(3000);
    expectEvent('out_of_stock_alert after mail alert success', since(pushes, mark), 'out_of_stock_alert', (e) => (!e.item_id ? 'item_id missing' : null));
});

// ---------------------------------------------------------------- newsletter
await step('newsletter_signup', async (got) => {
    await goto('/');
    const form = page.locator('.ps-emailsubscription form, .block_newsletter form').first();
    await form.locator('input[name="email"]').fill(`nl-${stamp}@example.com`);
    const mark = pushes.length;
    await Promise.all([
        page.waitForLoadState('load'),
        form.locator('[type="submit"], button[name="submitNewsletter"], input[name="submitNewsletter"]').first().click(),
    ]);
    await page.waitForTimeout(2000);
    expectEvent('newsletter_signup after footer subscribe', since(pushes, mark), 'newsletter_signup', null);
    const mark2 = pushes.length;
    await goto('/');
    expectNoEvent('newsletter_signup not repeated on next page', since(pushes, mark2), 'newsletter_signup');
});

// ---------------------------------------------------------------- cart
await step('cart', async (got) => {
    // Second cart line, so removing one still leaves a line to increment.
    await goto('/6-mug-the-best-is-yet-to-come.html');
    await page.locator('#add-to-cart-or-refresh [data-button-action="add-to-cart"]').first().click();
    await page.waitForTimeout(2500);
    await goto('/cart?action=show');
    expectEvent('view_cart', got(), 'view_cart', (e) => ecommerceProblem(e));

    const mark = pushes.length;
    const voucherToggle = page.locator('[data-ps-ref="voucher-accordion-button"], .promo-code-button a, .cart-voucher .collapse-button').first();
    if (await voucherToggle.count()) await voucherToggle.click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('input[name="discount_name"]').first().fill('TEST10');
    await page.locator('input[name="discount_name"]').first().press('Enter');
    await page.waitForTimeout(3000);
    expectEvent('apply_voucher TEST10', since(pushes, mark), 'apply_voucher', (e) => (e.coupon !== 'TEST10' ? `coupon "${e.coupon}"` : null));

    const mark3 = pushes.length;
    const up = page.locator('.js-increment-button, .bootstrap-touchspin-up').first();
    if (await up.count()) {
        await up.click();
        await page.waitForTimeout(3000);
        expectEvent('add_to_cart on cart quantity +1', since(pushes, mark3), 'add_to_cart', (e) => ecommerceProblem(e, { qty: 1 }));
    } else {
        record('add_to_cart on cart quantity +1', false, 'no increment button found');
    }

    const mark2 = pushes.length;
    await page.locator('[data-link-action="delete-from-cart"]').first().click();
    await page.waitForTimeout(3000);
    expectEvent('remove_from_cart on cart page', since(pushes, mark2), 'remove_from_cart', (e) => ecommerceProblem(e));
});

// ---------------------------------------------------------------- sign up / user id
await step('sign_up', async (got) => {
    await goto('/registration');
    const form = page.locator('#customer-form, form.js-customer-form').first();
    await form.locator('input[name="firstname"]').fill('Eve');
    await form.locator('input[name="lastname"]').fill('Tester');
    await form.locator('input[name="email"]').fill(email);
    await form.locator('input[name="password"]').fill(password);
    for (const cb of await form.locator('input[type="checkbox"][required]').all()) await cb.check({ force: true });
    const mark = pushes.length;
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), form.locator('[type="submit"]').last().click()]);
    await page.waitForTimeout(700);
    const list = since(pushes, mark);
    expectEvent('sign_up after registration', list, 'sign_up', (e) => (e.method ? null : 'method missing'), 1);
    expectNoEvent('no login on registration', list, 'login');
    record('user_id pushed when logged in', list.some((d) => d.user_id && d.user_properties && d.user_properties.logged_in === 'yes'), null);
});

// ---------------------------------------------------------------- wishlist (logged in)
await step('add_to_wishlist', async (got) => {
    await goto('/6-mug-the-best-is-yet-to-come.html');
    await page.waitForTimeout(1500);
    const mark = pushes.length;
    await page.locator('.wishlist-button-product, .wishlist-button-add').first().click();
    await page.waitForTimeout(1500);
    const listItem = page.locator('.wishlist-add-to .wishlist-list-item, .wishlist-chooselist li, .wishlist-list-item').first();
    if (await listItem.count()) {
        await listItem.click();
    } else {
        // No list yet: create one from the modal.
        const create = page.locator('.wishlist-add-to-new, .wishlist-create a, text=Create new list').first();
        await create.click();
        await page.locator('.wishlist-create input, input[placeholder*="ame"]').first().fill('E2E list');
        await page.locator('.wishlist-create .btn-primary, .wishlist-create button.modal-btn').last().click();
        await page.waitForTimeout(1500);
        await page.locator('.wishlist-list-item').first().click();
    }
    await page.waitForTimeout(2000);
    expectEvent('add_to_wishlist after choosing a list', since(pushes, mark), 'add_to_wishlist', (e) => ecommerceProblem(e), 1);
});

// ---------------------------------------------------------------- product review (logged in)
await step('review_submitted', async (got) => {
    await goto('/6-mug-the-best-is-yet-to-come.html');
    const mark = pushes.length;
    await page.locator('.post-product-comment, [data-bs-target="#post-product-comment-modal"], .product-comments-additional-info button').first().click();
    const modal = page.locator('#post-product-comment-modal');
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    // Five stars on every criterion.
    for (const star of await modal.locator('input[id^="star-5-criterion"]').all()) {
        const id = await star.getAttribute('id');
        await modal.locator(`label[for="${id}"]`).click({ force: true }).catch(() => star.evaluate((el) => { el.checked = true; }));
    }
    for (const stars of await modal.locator('.grade-stars').all()) {
        await stars.locator('.star, .star-content > *').last().click({ force: true }).catch(() => {});
    }
    await modal.locator('input[name="comment_title"]').fill('Great mug');
    await modal.locator('textarea[name="comment_content"]').fill('Holds coffee. Recommended.');
    await modal.locator('button[type="submit"], .post-comment-buttons button.btn-primary').last().click();
    await page.waitForTimeout(3500);
    expectEvent('review_submitted after posting comment', since(pushes, mark), 'review_submitted', (e) => (!e.item_id ? 'item_id missing' : null));
});

// ---------------------------------------------------------------- checkout
let orderConfirmationUrl = null;
await step('checkout', async (got) => {
    await goto('/7-mug-the-adventure-begins.html');
    await page.locator('#add-to-cart-or-refresh [data-button-action="add-to-cart"]').first().click();
    await page.waitForTimeout(2000);
    const mark = pushes.length;
    await goto('/order');
    expectEvent('begin_checkout on entering checkout', since(pushes, mark), 'begin_checkout', (e) => ecommerceProblem(e));

    // Address step
    const addr = page.locator('form:has(input[name="address1"])').first();
    if (await addr.count()) {
        await addr.locator('input[name="address1"]').fill('Slovenska cesta 1');
        await addr.locator('input[name="postcode"]').fill('SI-1000');
        await addr.locator('input[name="city"]').fill('Ljubljana');
        const phone = addr.locator('input[name="phone"]');
        if (await phone.count()) await phone.fill('041 123 456');
        await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), addr.locator('button[name="confirm-addresses"], [type="submit"]').last().click()]);
        await page.waitForTimeout(700);
    }

    // Delivery step: switch carrier, then continue.
    const markShip = pushes.length;
    const otherCarrier = page.locator('input[name^="delivery_option"]:not(:checked)').first();
    if (await otherCarrier.count()) {
        await otherCarrier.check({ force: true });
        await page.waitForTimeout(2500);
    }
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }).catch(() => {}),
        page.locator('button[name="confirmDeliveryOption"]').first().click(),
    ]);
    await page.waitForTimeout(1000);
    expectEvent('add_shipping_info with shipping_tier', since(pushes, markShip), 'add_shipping_info', (e) =>
        ecommerceProblem(e) || (!e.ecommerce.shipping_tier ? 'shipping_tier missing' : null)
    );
    const starts = eventsNamed(since(pushes, mark), 'begin_checkout').length;
    record('begin_checkout once across checkout steps', starts === 1, starts === 1 ? null : `fired ${starts}x`);

    // Payment step
    const markPay = pushes.length;
    const pay = page.locator('input[name="payment-option"]');
    const labels = await pay.evaluateAll((inputs) => inputs.map((i) => (i.dataset.moduleName || '') + ':' + i.id));
    const pick = labels.findIndex((l) => /wire|check|cash/.test(l));
    await pay.nth(pick >= 0 ? pick : 0).check({ force: true });
    await page.waitForTimeout(500);
    expectEvent('add_payment_info with payment_type', since(pushes, markPay), 'add_payment_info', (e) =>
        ecommerceProblem(e) || (!e.ecommerce.payment_type ? 'payment_type missing' : null)
    );
    await page.locator('input[name^="conditions_to_approve"]').first().check({ force: true });
    await page.waitForTimeout(300);
    const payInfo = eventsNamed(since(pushes, mark), 'add_payment_info').length;
    record('add_payment_info fired once in whole checkout', payInfo === 1, payInfo === 1 ? null : `fired ${payInfo}x`);

    const markBuy = pushes.length;
    await Promise.all([
        page.waitForURL(/order-confirmation|controller=order-confirmation/, { timeout: 20000 }),
        page.locator('#payment-confirmation button, .js-payment-confirmation button').first().click(),
    ]);
    await page.waitForTimeout(1000);
    orderConfirmationUrl = page.url();
    expectEvent('purchase on order confirmation', since(pushes, markBuy), 'purchase', (e) =>
        ecommerceProblem(e) ||
        (!e.ecommerce.transaction_id ? 'transaction_id missing' : null) ||
        (e.ecommerce.tax === undefined ? 'tax missing' : null) ||
        (e.ecommerce.items.some((i) => /\(.*:/.test(i.item_name)) ? 'item_name carries the combination' : null)
    );
    const mark2 = pushes.length;
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    expectNoEvent('purchase not repeated on confirmation reload', since(pushes, mark2), 'purchase');
});

// ---------------------------------------------------------------- login
await step('login', async (got) => {
    await goto('/?mylogout=');
    await goto('/login');
    const form = page.locator('#login-form, form.login-form').first();
    await form.locator('input[name="email"]').fill(email);
    await form.locator('input[name="password"]').fill(password);
    const mark = pushes.length;
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), form.locator('[type="submit"]').last().click()]);
    await page.waitForTimeout(700);
    expectEvent('login after sign-in', since(pushes, mark), 'login', (e) => (e.method ? null : 'method missing'), 1);
    const mark2 = pushes.length;
    await goto('/');
    expectNoEvent('login not repeated on next page', since(pushes, mark2), 'login');
});

// ---------------------------------------------------------------- dataLayer hygiene
{
    let bad = 0;
    for (let i = 0; i < pushes.length; i += 1) {
        const d = pushes[i].data;
        if (d && d.ecommerce && d.event) {
            const prev = pushes[i - 1] && pushes[i - 1].data;
            if (!(prev && prev.ecommerce === null && Object.keys(prev).length === 1)) bad += 1;
        }
    }
    record('every ecommerce push preceded by {ecommerce: null}', bad === 0, bad ? `${bad} pushes without clear` : null);
}
record('no JS errors on pages', errors.length === 0, errors.slice(0, 5).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Account: ${email}`);
if (orderConfirmationUrl) console.log(`Order confirmation: ${orderConfirmationUrl}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
