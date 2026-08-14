{**
 * Fires exactly once per order (see COOKIE_ORDER_PREFIX dedup guard in
 * hookDisplayOrderConfirmation) - reloading the confirmation page never
 * pushes a second `purchase` event.
 *}
<script type="text/javascript">
    window.dataLayer = window.dataLayer || [];
    dataLayer.push(JSON.parse(atob('{$ga4_purchase_b64}')));
</script>
