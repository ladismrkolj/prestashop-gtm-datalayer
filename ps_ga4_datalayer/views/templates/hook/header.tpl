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
    Array.prototype.push.apply(window.dataLayer, JSON.parse(atob('{$ga4_events_b64}')));
    window.psGa4ListItems = Object.assign({}, window.psGa4ListItems || {}, JSON.parse(atob('{$ga4_list_items_b64}')));
    window.psGa4CurrentItem = JSON.parse(atob('{$ga4_current_item_b64}')) || window.psGa4CurrentItem || null;
</script>
{if $ga4_enable_injection && $ga4_head_snippet|trim != ''}
{$ga4_head_snippet nofilter}
{/if}
