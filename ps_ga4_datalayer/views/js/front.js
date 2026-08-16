/**
 * ps_ga4_datalayer - front-end GA4 dataLayer event listener.
 *
 * This file only handles events that genuinely need to happen in the
 * browser: interactions on PrestaShop's native `prestashop.on()` event bus,
 * and DOM click/submit delegation for things the bus doesn't cover
 * (wishlist, share, promotions, voucher, newsletter, back-in-stock,
 * reviews). Every purely page-load event (view_item_list, view_item,
 * view_cart, begin_checkout, purchase, search, login, sign_up) is already
 * pushed server-side by the module's PHP hooks before this file runs - see
 * views/templates/hook/header.tpl.
 *
 * ---------------------------------------------------------------------
 * A note on reliability: `prestashop.on()` bus events (updateCart,
 * updatedDeliveryForm, termsUpdated, clickQuickView, updateProduct) are
 * part of PrestaShop core/Classic-theme JS and are stable across themes.
 * DOM selectors for third-party-ish blocks (wishlist, newsletter,
 * back-in-stock, reviews) vary more between theme versions/overrides, so
 * they are kept in the SELECTORS map below and can be overridden without
 * touching this file - see README "Customizing selectors".
 * ---------------------------------------------------------------------
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    window.dataLayer = window.dataLayer || [];

    var moduleConfig = window.psGa4Config || {};
    var listItems = window.psGa4ListItems || {};
    var currentItem = window.psGa4CurrentItem || null;

    /** Override any selector by defining window.ga4DataLayerSelectors BEFORE this file runs. */
    var SELECTORS = Object.assign(
        {
            productWrapper: '.js-product-miniature, [data-id-product]',
            productLink: '.js-product-miniature a, [data-id-product] a',
            wishlistButton: '.wishlist-button-add, [class*="wishlist-button"], .js-wishlist-btn, a[data-id-product][data-fancybox-type]',
            shareLink: '.social-sharing a, .share-buttons a',
            promotionElement: '[data-ga4-promotion-id], .js-carousel .carousel-item, #carousel .carousel-item',
            deliveryOptionContainer: '.delivery-option, .delivery-options-list li',
            deliveryOptionName: '.carrier-name, .delivery-option-name',
            paymentOptionInput: 'input[name="payment-option"], .payment-options input[type="radio"]',
            paymentOptionContainer: '.payment-option, .payment_module',
            paymentOptionName: '.payment-option-name, .payment_module_name, label',
            voucherForm: '#promo-code-form, form[name="voucher"], form[name="addDiscount"]',
            voucherInput: 'input[name="discount_name"], #promo-code, input[name="voucher_code"]',
            // ps_emailsubscription: success renders as
            // `.notification-success` inside #blockEmailSubscription_<hook>
            newsletterSuccess:
                '.block_newsletter .notification-success, [id^="blockEmailSubscription"] .notification-success, .block-newsletter .alert-success',
            // ps_emailalerts: a button inside .js-mailalert, no <form>
            mailAlertWrapper: '.js-mailalert',
            mailAlertButton: '.js-mailalert-add',
            mailAlertSuccess: '.js-mailalert-alerts [data-alert="success"], .js-mailalert-alerts .alert-success',
            // productcomments: AJAX form + confirmation modal
            reviewForm: '#post-product-comment-form, form[id*="comment-form"], form[name="product_comment"]',
            reviewSuccessModal: '#product-comment-posted-modal',
        },
        window.ga4DataLayerSelectors || {}
    );

    /* ------------------------------------------------------------------ *
     *  Core helpers
     * ------------------------------------------------------------------ */

    function push(eventName, extra) {
        var payload = Object.assign({ event: eventName }, extra || {});

        // Google requires clearing the previous ecommerce object before
        // each new ecommerce push. GTM's data model merges successive
        // pushes, so without this the items array from an earlier event
        // (e.g. a full view_item_list) bleeds into a later, smaller one
        // (e.g. select_item), inflating item counts and revenue.
        if (payload.ecommerce) {
            window.dataLayer.push({ ecommerce: null });
        }

        window.dataLayer.push(payload);
        if (window.psGa4Debug) {
            // eslint-disable-next-line no-console
            console.log('[GA4 dataLayer]', payload);
        }
    }

    /**
     * Resolve a product id from whatever a PrestaShop bus event hands over:
     * a DOM element (clickQuickView passes the miniature itself), a jQuery
     * wrapper, or a plain object. Falls back to the nearest
     * [data-id-product] ancestor.
     */
    function readProductId(subject) {
        if (!subject) {
            return null;
        }

        // jQuery object -> underlying element
        var el = subject.jquery && subject.length ? subject[0] : subject;

        if (el && el.dataset) {
            if (el.dataset.idProduct) {
                return el.dataset.idProduct;
            }
            if (el.dataset.productId) {
                return el.dataset.productId;
            }
        }
        if (el && typeof el.getAttribute === 'function') {
            var direct = el.getAttribute('data-id-product') || el.getAttribute('data-product-id');
            if (direct) {
                return direct;
            }
            var holder = closest(el, '[data-id-product]');
            if (holder) {
                return holder.getAttribute('data-id-product');
            }
        }

        // Plain object payloads (other emitters / third-party modules)
        if (typeof el === 'object') {
            return el.id_product || el.idProduct || el.productId || null;
        }

        return null;
    }

    function closest(el, selector) {
        if (!el || typeof el.closest !== 'function') {
            return null;
        }
        try {
            return el.closest(selector);
        } catch (e) {
            return null;
        }
    }

    function toFloat(value) {
        var n = parseFloat(String(value == null ? '' : value).replace(',', '.'));
        return isNaN(n) ? 0 : Math.round(n * 100) / 100;
    }

    function text(el) {
        return el && el.textContent ? el.textContent.trim() : '';
    }

    function currency() {
        return moduleConfig.currency || 'EUR';
    }

    function trackPromotionsEnabled() {
        return !!moduleConfig.trackPromotions;
    }

    function trackEngagementEnabled() {
        return !!moduleConfig.trackEngagement;
    }

    /**
     * Best-effort item lookup: prefer the server-rendered list item (has
     * full category/brand/list metadata), then the current product-page
     * item, then a minimal stub so we always push *something* usable.
     */
    function resolveItem(idProduct, overrides) {
        var id = String(idProduct);
        var base = null;

        if (listItems && listItems[id]) {
            base = listItems[id];
        } else if (currentItem && String(moduleConfig.currentProductId) === id) {
            base = currentItem;
        }

        var item = Object.assign({}, base || { item_id: id, currency: currency(), quantity: 1 });

        return Object.assign(item, overrides || {});
    }

    /**
     * Watches a container for a "success" indicator appearing (used for
     * AJAX-submitted forms - newsletter, back-in-stock, reviews - that
     * don't emit anything on the prestashop bus). Resolves once, or never
     * if no success marker shows up within the timeout.
     */
    function watchForSuccess(container, successSelector, timeoutMs, callback) {
        if (!container) {
            return;
        }

        var done = false;
        var finish = function () {
            if (done) {
                return;
            }
            done = true;
            observer.disconnect();
            callback();
        };

        var observer = new MutationObserver(function () {
            if (container.querySelector(successSelector)) {
                finish();
            }
        });

        observer.observe(container, { childList: true, subtree: true, attributes: true });

        if (container.querySelector(successSelector)) {
            finish();
        }

        window.setTimeout(function () {
            if (!done) {
                done = true;
                observer.disconnect();
            }
        }, timeoutMs || 6000);
    }

    /* ------------------------------------------------------------------ *
     *  select_item - click on a product card within a list/grid
     * ------------------------------------------------------------------ */

    function initSelectItem() {
        document.addEventListener(
            'click',
            function (event) {
                var link = closest(event.target, SELECTORS.productLink);
                if (!link) {
                    return;
                }

                var wrapper = closest(link, SELECTORS.productWrapper);
                if (!wrapper) {
                    return;
                }

                var idProduct = wrapper.getAttribute('data-id-product');
                if (!idProduct) {
                    return;
                }

                var item = resolveItem(idProduct);

                push('select_item', {
                    ecommerce: {
                        item_list_id: item.item_list_id,
                        item_list_name: item.item_list_name,
                        items: [item],
                    },
                });
            },
            true
        );
    }

    /* ------------------------------------------------------------------ *
     *  view_item on Quick View open (prestashop.on('clickQuickView'))
     * ------------------------------------------------------------------ */

    function initQuickView() {
        if (!window.prestashop || typeof window.prestashop.on !== 'function') {
            return;
        }

        // IMPORTANT: the Classic theme emits clickQuickView with the DOM
        // ELEMENT as its payload, not an object - see classic-theme
        // _dev/js/listing.js, which reads `elm.dataset.idProduct`. Treating
        // the payload as `{id_product: ...}` (as an earlier version did)
        // resolves nothing and the event never fires.
        window.prestashop.on('clickQuickView', function (elm) {
            var idProduct = readProductId(elm);

            if (!idProduct) {
                return;
            }

            var item = resolveItem(idProduct);

            push('view_item', {
                ecommerce: {
                    currency: currency(),
                    value: toFloat(item.price),
                    items: [item],
                },
            });
        });
    }

    /* ------------------------------------------------------------------ *
     *  add_to_cart / remove_from_cart (prestashop.on('updateCart'))
     * ------------------------------------------------------------------ */

    function initCartEvents() {
        if (!window.prestashop || typeof window.prestashop.on !== 'function') {
            return;
        }

        window.prestashop.on('updateCart', function (data) {
            var reason = (data && data.reason) || {};
            var resp = (data && data.resp) || {};
            var linkAction = reason.linkAction || reason.link_action;

            // `reason` is the raw dataset of the clicked element (see
            // classic-theme _dev/js/cart.js: `reason: dataset`), so
            // linkAction mirrors data-link-action verbatim. The cart's
            // delete link is data-link-action="delete-from-cart" - matching
            // only 'delete' (as an earlier version did) meant
            // remove_from_cart never fired from the cart page.
            var isAdd = linkAction === 'add-to-cart';
            var isRemove = linkAction === 'delete-from-cart' || linkAction === 'delete';

            if (!isAdd && !isRemove) {
                return; // update-quantity and other reasons are out of scope
            }

            var idProduct = reason.idProduct || reason.id_product;
            if (!idProduct) {
                return;
            }

            var quantity = Math.abs(parseInt(reason.quantity, 10) || 1);
            var price = extractPriceFromCartResponse(resp, idProduct) || null;

            // item_variant, if any, comes from the server-rendered base item
            // resolved below (resolveItem) - the updateCart reason itself
            // doesn't carry a human-readable combination label.
            var item = resolveItem(idProduct, { quantity: quantity });
            if (price !== null) {
                item.price = toFloat(price);
            }

            var eventName = isAdd ? 'add_to_cart' : 'remove_from_cart';

            push(eventName, {
                ecommerce: {
                    currency: currency(),
                    value: toFloat(item.price) * quantity,
                    items: [item],
                },
            });
        });
    }

    /**
     * `resp.cart` (from the updateCart bus event) mirrors the shape of
     * PrestaShop core's own `window.prestashop.cart` object: each row in
     * `.products` identifies the product via `id` (not `id_product`) and
     * exposes the live, reduction-applied price as `price_with_reduction`.
     * Both are matched defensively in case a theme override changes this.
     */
    function extractPriceFromCartResponse(resp, idProduct) {
        try {
            var products = resp && resp.cart && resp.cart.products;
            if (!Array.isArray(products)) {
                return null;
            }
            for (var i = 0; i < products.length; i += 1) {
                var row = products[i];
                var rowId = row.id != null ? row.id : row.id_product;
                if (String(rowId) === String(idProduct)) {
                    if (row.price_with_reduction != null) {
                        return row.price_with_reduction;
                    }
                    return row.price_amount != null ? row.price_amount : row.price;
                }
            }
        } catch (e) {
            /* best-effort only */
        }
        return null;
    }

    /* ------------------------------------------------------------------ *
     *  view_item_variants (prestashop.on('updatedProduct'))
     * ------------------------------------------------------------------ */

    function initVariantChange() {
        if (!window.prestashop || typeof window.prestashop.on !== 'function') {
            return;
        }

        // `updateProduct` and `updatedProduct` are two halves of ONE
        // interaction, not aliases: the theme emits `updateProduct` to
        // REQUEST a refresh (classic-theme _dev/js/product.js), and core
        // emits `updatedProduct` once the new combination has actually
        // loaded. Subscribing to both (as an earlier version did) produced
        // two view_item_variants per single click. Only the completion
        // event is correct - it is also the one carrying product data.
        window.prestashop.on('updatedProduct', function (data) {
            var payload = data || {};
            var product = payload.product || (payload.resp && payload.resp.product) || payload.resp || payload;

            var idProduct =
                product.id_product ||
                payload.id_product ||
                moduleConfig.currentProductId;

            if (!idProduct) {
                return;
            }

            var idProductAttribute =
                product.id_product_attribute ||
                payload.id_product_attribute ||
                null;

            var overrides = {};
            if (idProductAttribute) {
                overrides.item_variant = String(product.reference || idProductAttribute);
            }
            if (product.price_amount != null) {
                overrides.price = toFloat(product.price_amount);
            } else if (product.price != null) {
                overrides.price = toFloat(product.price);
            }
            if (product.reference) {
                overrides.item_id = String(product.reference);
            }

            var item = resolveItem(idProduct, overrides);

            push('view_item_variants', {
                ecommerce: {
                    currency: currency(),
                    value: toFloat(item.price),
                    items: [item],
                },
            });
        });
    }

    /* ------------------------------------------------------------------ *
     *  add_shipping_info (prestashop.on('updatedDeliveryForm'))
     * ------------------------------------------------------------------ */

    function initShippingInfo() {
        if (!window.prestashop || typeof window.prestashop.on !== 'function') {
            return;
        }

        window.prestashop.on('updatedDeliveryForm', function (data) {
            var shippingTier = extractSelectedLabel(
                'input[name^="delivery_option"]:checked, input[type="radio"][name*="delivery"]:checked',
                SELECTORS.deliveryOptionContainer,
                SELECTORS.deliveryOptionName
            );

            push('add_shipping_info', {
                ecommerce: Object.assign({ shipping_tier: shippingTier || undefined }, checkoutEcommerceBase()),
            });
        });
    }

    /* ------------------------------------------------------------------ *
     *  add_payment_info (payment option selection)
     * ------------------------------------------------------------------ */

    function initPaymentInfo() {
        var fired = false;

        var fire = function (target) {
            var paymentType = extractSelectedLabel(
                SELECTORS.paymentOptionInput + ':checked',
                SELECTORS.paymentOptionContainer,
                SELECTORS.paymentOptionName
            );

            if (!paymentType && target) {
                var container = closest(target, SELECTORS.paymentOptionContainer);
                paymentType = container ? text(container) : '';
            }

            push('add_payment_info', {
                ecommerce: Object.assign({ payment_type: paymentType || undefined }, checkoutEcommerceBase()),
            });
        };

        document.addEventListener('change', function (event) {
            if (closest(event.target, SELECTORS.paymentOptionInput)) {
                fire(event.target);
            }
        });

        if (window.prestashop && typeof window.prestashop.on === 'function') {
            window.prestashop.on('termsUpdated', function () {
                if (!fired) {
                    fired = true;
                    fire(null);
                }
            });
        }
    }

    function extractSelectedLabel(inputSelector, containerSelector, labelSelector) {
        var input = document.querySelector(inputSelector);
        if (!input) {
            return '';
        }
        var container = closest(input, containerSelector) || input.parentElement;
        if (!container) {
            return '';
        }
        var label = container.querySelector(labelSelector);
        return label ? text(label) : '';
    }

    function checkoutEcommerceBase() {
        return moduleConfig.cart || { currency: currency() };
    }

    /* ------------------------------------------------------------------ *
     *  add_to_wishlist
     * ------------------------------------------------------------------ */

    function pushAddToWishlist(idProduct, overrides) {
        var item = resolveItem(idProduct, overrides);

        push('add_to_wishlist', {
            ecommerce: {
                currency: currency(),
                value: toFloat(item.price),
                items: [item],
            },
        });
    }

    /**
     * Preferred path for PrestaShop's official `blockwishlist` module.
     *
     * That module is Vue-based and exposes its internal event bus as
     * `window.WishlistEventBus`, announcing readiness by emitting
     * `wishlistEventBusInit` on the PrestaShop bus. Its `addedToWishlist`
     * event is the only *truthful* signal available: a raw click on the
     * heart is not an add, because
     *   - a logged-out visitor gets the login modal instead;
     *   - a logged-in visitor first picks a list in a modal, and may cancel;
     *   - clicking an already-filled heart REMOVES the product.
     * Tracking clicks would over-count all three cases.
     */
    function initWishlistEventBus() {
        var subscribed = false;

        var subscribe = function () {
            if (subscribed || !window.WishlistEventBus || typeof window.WishlistEventBus.$on !== 'function') {
                return;
            }
            subscribed = true;

            window.WishlistEventBus.$on('addedToWishlist', function (event) {
                var detail = (event && event.detail) || {};
                if (!detail.productId) {
                    return;
                }
                pushAddToWishlist(detail.productId);
            });
        };

        if (window.prestashop && typeof window.prestashop.on === 'function') {
            window.prestashop.on('wishlistEventBusInit', subscribe);
        }

        // The bus may already exist if this file executes after the module's
        // own bundle (asset order isn't guaranteed), so try immediately and
        // then a few times while the Vue apps mount.
        subscribe();
        var attempts = 0;
        var poll = window.setInterval(function () {
            attempts += 1;
            subscribe();
            if (subscribed || attempts >= 20) {
                window.clearInterval(poll);
            }
        }, 250);

        return function () {
            return subscribed;
        };
    }

    /**
     * Fallback for themes/modules that render a plain wishlist link instead
     * of blockwishlist's Vue button. Skipped entirely once the official bus
     * is wired up, so the two can never double-count.
     */
    function initWishlistClickFallback(isBusActive) {
        document.addEventListener(
            'click',
            function (event) {
                if (isBusActive()) {
                    return;
                }

                var button = closest(event.target, SELECTORS.wishlistButton);
                if (!button) {
                    return;
                }

                // blockwishlist uses data-product-id; other modules and
                // product miniatures use data-id-product. Accept both, on
                // the element itself or any ancestor, and fall back to the
                // current product page.
                var idProduct =
                    attrFrom(button, 'data-product-id') ||
                    attrFrom(button, 'data-id-product') ||
                    moduleConfig.currentProductId;

                if (!idProduct) {
                    return;
                }

                pushAddToWishlist(idProduct);
            },
            true
        );
    }

    function attrFrom(el, attribute) {
        if (el && el.hasAttribute && el.hasAttribute(attribute)) {
            return el.getAttribute(attribute);
        }
        var holder = closest(el, '[' + attribute + ']');

        return holder ? holder.getAttribute(attribute) : null;
    }

    /* ------------------------------------------------------------------ *
     *  share
     * ------------------------------------------------------------------ */

    function initShare() {
        if (!trackEngagementEnabled()) {
            return;
        }

        document.addEventListener(
            'click',
            function (event) {
                var link = closest(event.target, SELECTORS.shareLink);
                if (!link) {
                    return;
                }

                // ps_sharebuttons renders `<li class="facebook"><a>` - the
                // network name is on the LI, not the anchor, so reading the
                // anchor's class (as an earlier version did) always yielded
                // "unknown".
                var holder = closest(link, 'li') || link;
                var method =
                    (holder.className || '').split(/\s+/).filter(Boolean)[0] ||
                    (link.className || '').split(/\s+/).filter(Boolean)[0] ||
                    text(link) ||
                    'unknown';
                var idProduct = moduleConfig.currentProductId;

                push('share', {
                    method: method,
                    content_type: 'product',
                    item_id: idProduct ? String(idProduct) : undefined,
                });
            },
            true
        );
    }

    /* ------------------------------------------------------------------ *
     *  view_promotion / select_promotion
     *  Opt-in via data-ga4-promotion-id / data-ga4-promotion-name so any
     *  theme/module can enable tracking without a template override:
     *    <a data-ga4-promotion-id="summer-sale" data-ga4-promotion-name="Summer Sale" href="...">
     * ------------------------------------------------------------------ */

    function initPromotions() {
        if (!trackPromotionsEnabled()) {
            return;
        }

        var elements = document.querySelectorAll(SELECTORS.promotionElement);
        if (!elements.length) {
            return;
        }

        var promotionData = function (el) {
            var link = el.matches('a') ? el : el.querySelector('a');
            return {
                promotion_id: el.getAttribute('data-ga4-promotion-id') || el.id || undefined,
                promotion_name: el.getAttribute('data-ga4-promotion-name') || (link ? link.getAttribute('title') : undefined) || text(el).slice(0, 80) || undefined,
                creative_slot: el.getAttribute('data-ga4-creative-slot') || undefined,
            };
        };

        if ('IntersectionObserver' in window) {
            var seen = new WeakSet();
            var observer = new IntersectionObserver(
                function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting && !seen.has(entry.target)) {
                            seen.add(entry.target);
                            push('view_promotion', promotionData(entry.target));
                            observer.unobserve(entry.target);
                        }
                    });
                },
                { threshold: 0.5 }
            );
            elements.forEach(function (el) {
                observer.observe(el);
            });
        }

        document.addEventListener(
            'click',
            function (event) {
                var el = closest(event.target, SELECTORS.promotionElement);
                if (!el) {
                    return;
                }
                push('select_promotion', promotionData(el));
            },
            true
        );
    }

    /* ------------------------------------------------------------------ *
     *  apply_voucher (prestashop.on('updateCart') with addDiscount reason)
     * ------------------------------------------------------------------ */

    function initVoucher() {
        var lastAttemptedCode = '';

        document.addEventListener('submit', function (event) {
            var form = closest(event.target, SELECTORS.voucherForm);
            if (!form) {
                return;
            }
            var input = form.querySelector(SELECTORS.voucherInput);
            lastAttemptedCode = input ? input.value.trim() : '';
        });

        if (window.prestashop && typeof window.prestashop.on === 'function') {
            window.prestashop.on('updateCart', function (data) {
                var reason = (data && data.reason) || {};
                var linkAction = reason.linkAction || reason.link_action;

                // The Classic theme's voucher link is
                // data-link-action="add-voucher"; the camelCase spellings
                // are kept for third-party carts.
                if (
                    linkAction !== 'add-voucher' &&
                    linkAction !== 'addDiscount' &&
                    linkAction !== 'add-discount' &&
                    linkAction !== 'addVoucher'
                ) {
                    return;
                }

                push('apply_voucher', {
                    coupon: reason.voucher || lastAttemptedCode || undefined,
                    value: (data && data.resp && data.resp.cart && toFloat(data.resp.cart.total_discounts)) || undefined,
                    currency: currency(),
                });
            });
        }
    }

    /* ------------------------------------------------------------------ *
     *  out_of_stock_alert (ps_emailalerts back-in-stock form)
     * ------------------------------------------------------------------ */

    /**
     * ps_emailalerts renders NO <form> at all - it is a plain
     * <div class="js-mailalert"> holding an email input and a
     * <button class="js-mailalert-add" data-product data-product-attribute>
     * that posts by AJAX (see the module's js/mailalerts.js). Listening for
     * a `submit` event, as an earlier version did, could therefore never
     * fire. Success is rendered into `.js-mailalert-alerts` as
     * `<article class="alert alert-success" data-alert="success">`.
     */
    function initOutOfStockAlert() {
        document.addEventListener(
            'click',
            function (event) {
                var button = closest(event.target, SELECTORS.mailAlertButton);
                if (!button) {
                    return;
                }

                var idProduct =
                    button.getAttribute('data-product') ||
                    readProductId(button) ||
                    moduleConfig.currentProductId;

                var wrapper = closest(button, SELECTORS.mailAlertWrapper) || document.body;

                watchForSuccess(wrapper, SELECTORS.mailAlertSuccess, 8000, function () {
                    push('out_of_stock_alert', {
                        item_id: idProduct ? String(idProduct) : undefined,
                    });
                });
            },
            true
        );
    }

    /* ------------------------------------------------------------------ *
     *  newsletter_signup (ps_emailsubscription footer module)
     * ------------------------------------------------------------------ */

    /**
     * ps_emailsubscription submits a plain <form method="post"> that causes
     * a FULL PAGE RELOAD - there is no AJAX. Watching the DOM for a success
     * message after submit (as an earlier version did) could never work,
     * because the page navigates away before any mutation happens.
     *
     * The result is rendered on the *next* page load as
     * `<p class="notification notification-success">` inside
     * `#blockEmailSubscription_<hook>`, and only when the module actually
     * processed a submission - so detecting it at load time is both correct
     * and self-limiting. Note the class is `notification-success`, not
     * Bootstrap's `alert-success`.
     */
    function initNewsletterSignup() {
        var success = document.querySelector(SELECTORS.newsletterSuccess);
        if (!success) {
            return;
        }

        // No PII (the email address) is ever pushed to the dataLayer.
        push('newsletter_signup', { method: 'footer_block' });
    }

    /* ------------------------------------------------------------------ *
     *  review_submitted (productcomments module)
     * ------------------------------------------------------------------ */

    /**
     * productcomments posts `#post-product-comment-form` by AJAX and, on
     * success, opens the `#product-comment-posted-modal` Bootstrap modal
     * (see the module's views/js/post-comment.js). The confirmation is that
     * modal becoming visible - not an `.alert-success` anywhere on the
     * page, which is what an earlier version waited for.
     */
    function initReviewSubmitted() {
        document.addEventListener('submit', function (event) {
            var form = closest(event.target, SELECTORS.reviewForm);
            if (!form) {
                return;
            }

            var idProduct = moduleConfig.currentProductId;

            waitForVisible(SELECTORS.reviewSuccessModal, 10000, function () {
                push('review_submitted', {
                    item_id: idProduct ? String(idProduct) : undefined,
                });
            });
        });
    }

    /**
     * Resolves once the element matching `selector` becomes visible, which
     * for a Bootstrap modal means gaining the `show` class / a non-none
     * display. Used where the success signal is a modal rather than an
     * inline message.
     */
    function waitForVisible(selector, timeoutMs, callback) {
        var done = false;
        var started = Date.now();

        var isVisible = function (el) {
            if (!el) {
                return false;
            }
            if (el.classList && el.classList.contains('show')) {
                return true;
            }
            var style = window.getComputedStyle ? window.getComputedStyle(el) : null;

            return !!(style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null);
        };

        var timer = window.setInterval(function () {
            if (done) {
                window.clearInterval(timer);
                return;
            }
            if (isVisible(document.querySelector(selector))) {
                done = true;
                window.clearInterval(timer);
                callback();
                return;
            }
            if (Date.now() - started > timeoutMs) {
                done = true;
                window.clearInterval(timer);
            }
        }, 200);
    }

    /* ------------------------------------------------------------------ *
     *  Bootstrap
     * ------------------------------------------------------------------ */

    function init() {
        initSelectItem();
        initQuickView();
        initCartEvents();
        initVariantChange();
        initShippingInfo();
        initPaymentInfo();
        initWishlistClickFallback(initWishlistEventBus());
        initShare();
        initPromotions();
        initVoucher();
        initOutOfStockAlert();
        initNewsletterSignup();
        initReviewSubmitted();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
