{**
 * Initialises window.dataLayer and pushes every server-computed, page-load
 * GA4 event (view_item_list, view_item, view_cart, begin_checkout, search,
 * login, sign_up) *before* the raw GTM head snippet is output, so GTM
 * replays them as soon as it boots.
 *}
{**
 * Payloads travel as base64 so a product name, search term or category
 * label containing `</script>` (or anything else) can never break out of
 * this tag - see Ps_ga4_datalayer::jsonToBase64().
 *}
<script type="text/javascript">
    window.dataLayer = window.dataLayer || [];
{if $ga4_has_user_payload}
    // First-party data (User-ID / user_properties / hashed user_data) is
    // pushed BEFORE any event, so GA4 attributes the very first event of
    // the session to the identified user rather than to an anonymous one.
    window.dataLayer.push(JSON.parse(atob('{$ga4_user_b64}')));
{/if}
    (function () {
        var events = JSON.parse(atob('{$ga4_events_b64}'));
        for (var i = 0; i < events.length; i += 1) {
            // Google requires clearing the previous ecommerce object before
            // each new ecommerce push: GTM's data model MERGES successive
            // pushes, so without this the items array of a previous event
            // bleeds into the next one (e.g. a 12-product view_item_list
            // leaving stale items behind on a 1-product select_item).
            if (events[i] && events[i].ecommerce) {
                window.dataLayer.push({ ecommerce: null });
            }
            window.dataLayer.push(events[i]);
        }
    })();
    window.psGa4ListItems = Object.assign({}, window.psGa4ListItems || {}, JSON.parse(atob('{$ga4_list_items_b64}')));
    window.psGa4CurrentItem = JSON.parse(atob('{$ga4_current_item_b64}')) || window.psGa4CurrentItem || null;
</script>
{if $ga4_enable_injection && $ga4_head_snippet|trim != ''}
{$ga4_head_snippet nofilter}
{/if}
