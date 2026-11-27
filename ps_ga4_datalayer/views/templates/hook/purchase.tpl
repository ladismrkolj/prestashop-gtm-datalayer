{**
 * Fires exactly once per order (see COOKIE_ORDER_PREFIX dedup guard in
 * hookDisplayOrderConfirmation) - reloading the confirmation page never
 * pushes a second `purchase` event.
 *}
<script>
  window.dataLayer = window.dataLayer || [];
  // Clear any previous ecommerce object first - GTM merges successive
  // pushes, and a purchase must never inherit stale items/value.
  window.dataLayer.push({ ecommerce: null });
  window.dataLayer.push({$ga4_purchase_json nofilter});
</script>
