{**
 * Informational panel shown above the settings form.
 *}
<div class="panel">
    <div class="panel-heading">
        <i class="icon-info-circle"></i> {l s='GA4 DataLayer & Google Tag Manager' mod='ps_ga4_datalayer'}
    </div>
    <div class="alert alert-info">
        <p>
            {l s='This module pushes 23 GA4-mapped events to window.dataLayer and lets you paste your Google Tag Manager container snippets below - no template edits required.' mod='ps_ga4_datalayer'}
        </p>
        <ol>
            <li>{l s='Create a GTM container at tagmanager.google.com and copy its <head> and <body> snippets into the fields below.' mod='ps_ga4_datalayer'}</li>
            <li>{l s='Enable "snippet injection" and save.' mod='ps_ga4_datalayer'}</li>
            <li>{l s='Inside GTM, add a GA4 Configuration tag plus Event tags reading from the dataLayer (e.g. All Pages trigger for page-level events, Custom Event triggers named after each event below).' mod='ps_ga4_datalayer'}</li>
            <li>{l s='Verify with Google Tag Assistant (tagassistant.google.com) or by running window.dataLayer in your browser console.' mod='ps_ga4_datalayer'}</li>
        </ol>
    </div>

    <table class="table">
        <thead>
            <tr>
                <th>{l s='Event' mod='ps_ga4_datalayer'}</th>
                <th>{l s='Fires on' mod='ps_ga4_datalayer'}</th>
            </tr>
        </thead>
        <tbody>
            <tr><td><code>view_item_list</code></td><td>{l s='Category, brand, supplier & search result pages' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>select_item</code></td><td>{l s='Clicking a product card in a list/grid' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>view_item</code></td><td>{l s='Product page load & Quick View' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>add_to_cart</code></td><td>{l s='Adding a product to the cart (incl. AJAX popups)' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>remove_from_cart</code></td><td>{l s='Removing a product from the cart' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>view_cart</code></td><td>{l s='Cart page / slide-out' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>begin_checkout</code></td><td>{l s='Entering the checkout controller' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>add_shipping_info</code></td><td>{l s='Selecting a carrier at checkout' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>add_payment_info</code></td><td>{l s='Selecting a payment method at checkout' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>purchase</code></td><td>{l s='Order confirmation page (deduplicated)' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>view_promotion</code> / <code>select_promotion</code></td><td>{l s='Homepage banners/slides carrying data-ga4-promotion-id' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>add_to_wishlist</code></td><td>{l s='Wishlist heart icon click' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>refund</code></td><td>{l s='Credit slip creation (front office or Back Office, via Measurement Protocol)' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>view_item_variants</code></td><td>{l s='Changing a product combination (color/size)' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>search</code></td><td>{l s='Search results page load' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>login</code> / <code>sign_up</code></td><td>{l s='Successful authentication / new customer registration' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>share</code></td><td>{l s='Social share button click on the product page' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>apply_voucher</code></td><td>{l s='Promo code successfully applied to the cart' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>out_of_stock_alert</code></td><td>{l s='Back-in-stock email alert submitted' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>newsletter_signup</code></td><td>{l s='Footer newsletter block submitted' mod='ps_ga4_datalayer'}</td></tr>
            <tr><td><code>review_submitted</code></td><td>{l s='Product comment/review form submitted' mod='ps_ga4_datalayer'}</td></tr>
        </tbody>
    </table>
</div>
