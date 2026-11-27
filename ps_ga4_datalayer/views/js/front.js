/**
 * ps_ga4_datalayer - interaction events.
 *
 * Page-load events (view_item_list, view_item, view_cart, begin_checkout,
 * purchase, search, login, sign_up) are pushed by the module's PHP at the
 * start of <body>. This file covers what only the browser can see, and
 * works with both official PrestaShop 9 themes (Hummingbird and Classic):
 *
 *  - Cart changes: every `updateCart` is diffed against the previous cart
 *    contents (prestashop.cart at load, then each response's cart). One
 *    code path therefore yields add_to_cart / remove_from_cart with real
 *    quantities, prices and variants for the product page, quick view,
 *    listing buttons, cart +/- and delete - in any theme.
 *  - Everything else listens to PrestaShop's event bus or uses delegated
 *    DOM listeners with selectors for both themes. Override any selector
 *    with window.ga4DataLayerSelectors (see README).
 *
 * Set window.psGa4Debug = true to log every push.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    window.dataLayer = window.dataLayer || [];

    var config = window.psGa4Config || {};

    var SELECTORS = Object.assign(
        {
            productMiniature: '.js-product-miniature, [data-id-product]',
            // Controls inside a product card that are not "open this product".
            miniatureControls: '.quick-view, .js-quickview, .wishlist-button-add, [data-button-action="add-to-cart"]',
            wishlistButton: '.wishlist-button-add, .js-wishlist-btn',
            shareLink: '.ps-sharebuttons a, .social-sharing a, .share-buttons a',
            promotion: '[data-ga4-promotion-id], .carousel-item',
            voucherInput: 'input[name="discount_name"]',
            deliveryOptionInput: 'input[name^="delivery_option"]',
            carrierName: '.carrier-name, .delivery-option__carrier-name',
            paymentOptionInput: 'input[name="payment-option"]',
            newsletterForm: '.block_newsletter form, .ps-emailsubscription form',
            // Rendered after Hummingbird's full-page post...
            newsletterSuccess:
                '.block_newsletter .alert-success, .ps-emailsubscription .alert-success, [id^="blockEmailSubscription"] .notification-success',
            // ...or inserted into Classic's form by AJAX.
            newsletterAjaxSuccess: '.alert-success, .notification-success',
            mailAlertButton: '.js-mailalert-add, [data-ps-action="emailalerts-subscribe"]',
            mailAlertWrapper: '.js-mailalert, [data-ps-ref="emailalerts"]',
            mailAlertSuccess: '.js-mailalert-alerts [data-alert="success"], .alert-success',
            reviewForm: '#post-product-comment-form',
            reviewSuccessModal: '#product-comment-posted-modal, #product-post-review-posted-modal',
        },
        window.ga4DataLayerSelectors || {}
    );

    /* ------------------------------------------------------------------ *
     *  Helpers
     * ------------------------------------------------------------------ */

    function push(eventName, extra) {
        var payload = Object.assign({ event: eventName }, extra || {});

        // GTM merges pushes: clear the previous ecommerce object first, or
        // an earlier event's items bleed into this one.
        if (payload.ecommerce) {
            window.dataLayer.push({ ecommerce: null });
        }

        window.dataLayer.push(payload);
        if (window.psGa4Debug) {
            // eslint-disable-next-line no-console
            console.log('[GA4 dataLayer]', payload);
        }
    }

    /** Server-rendered product data; read lazily so script order never matters. */
    function pageData() {
        return window.psGa4Page || {};
    }

    function on(eventName, handler) {
        if (window.prestashop && typeof window.prestashop.on === 'function') {
            window.prestashop.on(eventName, handler);
        }
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
        return el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    }

    function currency() {
        return config.currency || 'EUR';
    }

    /** Single-item ecommerce block; value = price * quantity. */
    function itemEcommerce(item) {
        return {
            currency: currency(),
            value: toFloat(toFloat(item.price) * (item.quantity || 1)),
            items: [item],
        };
    }

    /**
     * GA4 item for a product id: the server-rendered list item or the
     * product page item when known, otherwise a minimal stub.
     */
    function resolveItem(idProduct, overrides) {
        var id = String(idProduct);
        var data = pageData();
        var base = (data.listItems && data.listItems[id]) || null;

        if (!base && data.currentItem && String(config.currentProductId) === id) {
            base = data.currentItem;
        }

        return Object.assign({}, base || { item_id: id, currency: currency(), quantity: 1 }, overrides || {});
    }

    /** "S / White" - same label the PHP side builds (attribute-group order). */
    function variantLabel(attributes) {
        if (!attributes || typeof attributes !== 'object') {
            return '';
        }
        return Object.keys(attributes)
            .map(function (group) {
                return String(attributes[group]).trim();
            })
            .join(' / ');
    }

    /* ------------------------------------------------------------------ *
     *  Cart: add_to_cart / remove_from_cart by diffing cart contents
     * ------------------------------------------------------------------ */

    function lineKey(idProduct, idProductAttribute, idCustomization) {
        return [idProduct, idProductAttribute || 0, idCustomization || 0].join('-');
    }

    /** id-product-attribute-customization => cart row (presented cart product). */
    function cartLines(products) {
        var lines = {};
        (Array.isArray(products) ? products : []).forEach(function (row) {
            if (row && (row.id_product || row.id)) {
                lines[lineKey(row.id_product || row.id, row.id_product_attribute, row.id_customization)] = row;
            }
        });
        return lines;
    }

    function rowQuantity(row) {
        return parseInt(row.cart_quantity != null ? row.cart_quantity : row.quantity, 10) || 0;
    }

    function itemFromCartRow(row, quantity) {
        // List/brand/category context from the server item, live name,
        // price and variant from the cart row.
        var item = resolveItem(row.id_product || row.id, {
            item_id: String(row.reference || row.id_product || row.id),
            item_name: row.name,
            price: toFloat(row.price_amount != null ? row.price_amount : row.price_wt),
            quantity: quantity,
        });
        var variant = variantLabel(row.attributes);
        if (variant) {
            item.item_variant = variant;
        } else {
            delete item.item_variant;
        }
        if (!item.item_brand && row.manufacturer_name) {
            item.item_brand = row.manufacturer_name;
        }
        return item;
    }

    function initCartEvents() {
        var lines = cartLines(window.prestashop && window.prestashop.cart && window.prestashop.cart.products);

        on('updateCart', function (data) {
            var resp = (data && data.resp) || {};
            var reason = (data && data.reason) || {};
            var next;

            if (resp.cart && Array.isArray(resp.cart.products)) {
                next = cartLines(resp.cart.products);
            } else if (reason.linkAction === 'delete-from-cart') {
                // Hummingbird's delete hands over a raw fetch Response; the
                // reason still says exactly which line went away.
                next = Object.assign({}, lines);
                delete next[lineKey(reason.idProduct, reason.idProductAttribute, reason.idCustomization)];
            } else {
                return;
            }

            Object.keys(next).forEach(function (key) {
                var added = rowQuantity(next[key]) - (lines[key] ? rowQuantity(lines[key]) : 0);
                if (added > 0) {
                    push('add_to_cart', { ecommerce: itemEcommerce(itemFromCartRow(next[key], added)) });
                }
            });
            Object.keys(lines).forEach(function (key) {
                var removed = rowQuantity(lines[key]) - (next[key] ? rowQuantity(next[key]) : 0);
                if (removed > 0) {
                    push('remove_from_cart', { ecommerce: itemEcommerce(itemFromCartRow(lines[key], removed)) });
                }
            });

            lines = next;
        });
    }

    /* ------------------------------------------------------------------ *
     *  select_item / quick view
     * ------------------------------------------------------------------ */

    function initSelectItem() {
        document.addEventListener(
            'click',
            function (event) {
                if (!closest(event.target, 'a') || closest(event.target, SELECTORS.miniatureControls)) {
                    return;
                }
                var miniature = closest(event.target, SELECTORS.productMiniature);
                var idProduct = miniature && miniature.getAttribute('data-id-product');
                if (!idProduct) {
                    return;
                }

                var item = resolveItem(idProduct);
                push('select_item', {
                    ecommerce: { item_list_id: item.item_list_id, item_list_name: item.item_list_name, items: [item] },
                });
            },
            true
        );
    }

    function initQuickView() {
        var last = { id: null, at: 0 };

        // Classic (core.js) emits clickQuickView with {dataset}; Hummingbird
        // emits clickQuickview with the miniature element.
        var handler = function (payload) {
            var dataset = (payload && payload.dataset) || {};
            var idProduct = dataset.idProduct || (payload && payload.getAttribute && payload.getAttribute('data-id-product'));
            var now = Date.now();
            if (!idProduct || (last.id === idProduct && now - last.at < 1000)) {
                return;
            }
            last = { id: idProduct, at: now };

            var item = resolveItem(idProduct);
            push('view_item', { ecommerce: itemEcommerce(item) });
        };

        on('clickQuickView', handler);
        on('clickQuickview', handler);
    }

    /* ------------------------------------------------------------------ *
     *  view_item_variants
     * ------------------------------------------------------------------ */

    function initVariantChange() {
        var shown = String(pageData().idProductAttribute || 0);

        // updatedProduct also fires for quantity changes: only a different
        // combination is a variant view.
        on('updatedProduct', function (data) {
            var idProductAttribute = String((data && data.id_product_attribute) || 0);
            var variant = (pageData().variants || {})[idProductAttribute];
            if (!config.currentProductId || !variant || idProductAttribute === shown) {
                return;
            }
            shown = idProductAttribute;

            var item = resolveItem(config.currentProductId, { item_variant: variant.item_variant, price: variant.price });
            push('view_item_variants', { ecommerce: itemEcommerce(item) });
        });
    }

    /* ------------------------------------------------------------------ *
     *  Checkout: add_shipping_info / add_payment_info
     * ------------------------------------------------------------------ */

    function checkoutEcommerce(extra) {
        return Object.assign({}, config.cart || { currency: currency() }, extra);
    }

    function labelFor(input) {
        if (!input || !input.id) {
            return '';
        }
        var label = document.querySelector('label[for="' + input.id + '"]');
        if (!label) {
            return '';
        }
        return text(label.querySelector(SELECTORS.carrierName)) || text(label);
    }

    function initShippingInfo() {
        // Submitting the delivery step is "shipping info submitted",
        // whether or not the shopper changed the preselected carrier.
        document.addEventListener(
            'submit',
            function (event) {
                var form = event.target;
                if (!form || typeof form.querySelector !== 'function' || !form.querySelector(SELECTORS.deliveryOptionInput)) {
                    return;
                }
                var checked = form.querySelector(SELECTORS.deliveryOptionInput + ':checked');
                push('add_shipping_info', { ecommerce: checkoutEcommerce({ shipping_tier: labelFor(checked) || undefined }) });
            },
            true
        );
    }

    function initPaymentInfo() {
        var lastOption = null;

        document.addEventListener('change', function (event) {
            var input = closest(event.target, SELECTORS.paymentOptionInput);
            if (!input || !input.checked || input.id === lastOption) {
                return;
            }
            lastOption = input.id;
            var paymentType = labelFor(input) || input.getAttribute('data-module-name') || undefined;
            push('add_payment_info', { ecommerce: checkoutEcommerce({ payment_type: paymentType }) });
        });
    }

    /* ------------------------------------------------------------------ *
     *  add_to_wishlist (blockwishlist event bus, click fallback)
     * ------------------------------------------------------------------ */

    function pushAddToWishlist(idProduct) {
        push('add_to_wishlist', { ecommerce: itemEcommerce(resolveItem(idProduct)) });
    }

    /**
     * blockwishlist announces confirmed adds on window.WishlistEventBus
     * (`addedToWishlist`). A click on the heart is not an add: guests get a
     * login modal, the list picker can be cancelled and a filled heart
     * removes the product.
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
                if (detail.productId) {
                    pushAddToWishlist(detail.productId);
                }
            });
        };

        on('wishlistEventBusInit', subscribe);

        // The bus may already exist or mount later than this file runs.
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

    /** Other wishlist modules: count the click, unless blockwishlist's bus is active. */
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
                var idProduct = attrFrom(button, 'data-product-id') || attrFrom(button, 'data-id-product') || config.currentProductId;
                if (idProduct) {
                    pushAddToWishlist(idProduct);
                }
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
        if (!config.trackEngagement) {
            return;
        }

        document.addEventListener(
            'click',
            function (event) {
                var link = closest(event.target, SELECTORS.shareLink);
                if (!link) {
                    return;
                }
                // ps_sharebuttons: <li class="facebook"><a>...</a></li>
                var holder = closest(link, 'li') || link;
                var method = (holder.className || '').split(/\s+/).filter(Boolean)[0] || text(link) || 'unknown';

                push('share', {
                    method: method,
                    content_type: 'product',
                    item_id: config.currentProductId ? String(config.currentProductId) : undefined,
                });
            },
            true
        );
    }

    /* ------------------------------------------------------------------ *
     *  view_promotion / select_promotion
     *  Image slider slides, plus anything carrying data-ga4-promotion-id.
     * ------------------------------------------------------------------ */

    function promotionEcommerce(el) {
        var link = el.matches('a') ? el : el.querySelector('a');
        var image = el.querySelector('img');
        var heading = el.querySelector('h1, h2, h3, .caption-title');
        var id = el.getAttribute('data-ga4-promotion-id') || el.id || (link && link.getAttribute('href')) || '';
        var name =
            el.getAttribute('data-ga4-promotion-name') ||
            text(heading) ||
            (image && image.getAttribute('alt')) ||
            (link && link.getAttribute('title')) ||
            id;

        return {
            promotion_id: id || undefined,
            promotion_name: name || undefined,
            creative_slot: el.getAttribute('data-ga4-creative-slot') || undefined,
            // GA4 requires items on promotion events; the promotion itself
            // is the item unless the theme links a product.
            items: [{ item_id: id || name, item_name: name || id }],
        };
    }

    function initPromotions() {
        if (!config.trackPromotions) {
            return;
        }

        var elements = document.querySelectorAll(SELECTORS.promotion);
        if (!elements.length) {
            return;
        }

        if ('IntersectionObserver' in window) {
            var observer = new IntersectionObserver(
                function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            observer.unobserve(entry.target);
                            push('view_promotion', { ecommerce: promotionEcommerce(entry.target) });
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
                var el = closest(event.target, SELECTORS.promotion);
                if (el) {
                    push('select_promotion', { ecommerce: promotionEcommerce(el) });
                }
            },
            true
        );
    }

    /* ------------------------------------------------------------------ *
     *  apply_voucher
     * ------------------------------------------------------------------ */

    function initVoucher() {
        var code = '';

        // Both themes submit a form holding input[name="discount_name"].
        document.addEventListener(
            'submit',
            function (event) {
                var input = event.target && typeof event.target.querySelector === 'function' ? event.target.querySelector(SELECTORS.voucherInput) : null;
                if (input) {
                    code = String(input.value || '').trim();
                }
            },
            true
        );

        on('updateCart', function (data) {
            var reason = (data && data.reason) || {};
            var resp = (data && data.resp) || {};
            if (reason.linkAction !== 'add-voucher' || resp.hasError || (resp.errors && resp.errors.length)) {
                return;
            }
            push('apply_voucher', { coupon: code || undefined, currency: currency() });
        });
    }

    /* ------------------------------------------------------------------ *
     *  out_of_stock_alert / newsletter_signup / review_submitted
     *  These modules signal success only in the DOM.
     * ------------------------------------------------------------------ */

    /** Calls back once a visible `selector` match appears inside `container`; onTimeout otherwise. */
    function whenPresent(container, selector, timeoutMs, callback, onTimeout) {
        if (!container) {
            return;
        }
        var done = false;
        var check = function () {
            var match = container.querySelector(selector);
            // offsetParent is null for position:fixed elements such as
            // Bootstrap modals; getClientRects() covers those.
            var visible = match && (match.offsetParent !== null || (match.getClientRects && match.getClientRects().length > 0));
            if (!done && visible) {
                done = true;
                window.clearInterval(timer);
                callback();
            }
        };
        var timer = window.setInterval(check, 200);
        window.setTimeout(function () {
            if (!done) {
                done = true;
                window.clearInterval(timer);
                if (onTimeout) {
                    onTimeout();
                }
            }
        }, timeoutMs);
    }

    function initOutOfStockAlert() {
        document.addEventListener(
            'click',
            function (event) {
                var button = closest(event.target, SELECTORS.mailAlertButton);
                if (!button) {
                    return;
                }
                var idProduct = button.getAttribute('data-product') || config.currentProductId;
                try {
                    idProduct = JSON.parse(button.getAttribute('data-ps-data') || '{}').id_product || idProduct;
                } catch (e) {
                    /* keep the fallback */
                }

                whenPresent(closest(button, SELECTORS.mailAlertWrapper) || document.body, SELECTORS.mailAlertSuccess, 8000, function () {
                    push('out_of_stock_alert', { item_id: idProduct ? String(idProduct) : undefined });
                });
            },
            true
        );
    }

    function initNewsletterSignup() {
        // Hummingbird posts the form and shows the result after a reload;
        // Classic subscribes by AJAX and inserts the alert in place.
        if (document.querySelector(SELECTORS.newsletterSuccess)) {
            push('newsletter_signup', { method: 'footer_block' });
            return;
        }
        document.addEventListener(
            'submit',
            function (event) {
                var form = closest(event.target, SELECTORS.newsletterForm);
                if (form) {
                    whenPresent(form, SELECTORS.newsletterAjaxSuccess, 8000, function () {
                        push('newsletter_signup', { method: 'footer_block' });
                    });
                }
            },
            true
        );
    }

    function initReviewSubmitted() {
        var watching = false;

        // Hummingbird posts on the submit button's click without a submit
        // event; Classic submits the form. Either starts one watcher.
        var start = function (event) {
            if (watching || !closest(event.target, SELECTORS.reviewForm)) {
                return;
            }
            if (event.type === 'click' && !closest(event.target, '[type="submit"]')) {
                return;
            }
            watching = true;
            whenPresent(
                document.body,
                SELECTORS.reviewSuccessModal,
                10000,
                function () {
                    watching = false;
                    push('review_submitted', {
                        item_id: config.currentProductId ? String(config.currentProductId) : undefined,
                    });
                },
                function () {
                    watching = false;
                }
            );
        };

        document.addEventListener('submit', start, true);
        document.addEventListener('click', start, true);
    }

    /* ------------------------------------------------------------------ *
     *  view_item_list for AJAX listing updates (faceted search, paging)
     * ------------------------------------------------------------------ */

    function initListingUpdates() {
        on('updateProductList', function (data) {
            var products = data && Array.isArray(data.products) ? data.products : [];
            var first = pageData().listItems ? pageData().listItems[Object.keys(pageData().listItems)[0]] : null;
            if (!products.length || !first) {
                return;
            }

            var items = products.map(function (p, index) {
                var item = {
                    item_id: String(p.reference || p.id_product),
                    item_name: p.name,
                    currency: currency(),
                    item_brand: p.manufacturer_name || undefined,
                    price: toFloat(p.price_amount),
                    quantity: 1,
                    index: index,
                    item_list_id: first.item_list_id,
                    item_list_name: first.item_list_name,
                };
                pageData().listItems[String(p.id_product)] = item;
                return item;
            });

            push('view_item_list', {
                ecommerce: { item_list_id: first.item_list_id, item_list_name: first.item_list_name, items: items },
            });
        });
    }

    /* ------------------------------------------------------------------ *
     *  Bootstrap
     * ------------------------------------------------------------------ */

    function init() {
        initCartEvents();
        initSelectItem();
        initQuickView();
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
        initListingUpdates();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
