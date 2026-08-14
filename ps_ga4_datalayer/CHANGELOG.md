# Changelog

## 1.0.0

Initial release.

- 12 core GA4 eCommerce funnel events (`view_item_list`, `select_item`,
  `view_item`, `add_to_cart`, `remove_from_cart`, `view_cart`,
  `begin_checkout`, `add_shipping_info`, `add_payment_info`, `purchase`,
  `view_promotion`, `select_promotion`).
- 3 extended eCommerce events (`add_to_wishlist`, `refund`,
  `view_item_variants`).
- 4 store-engagement events (`search`, `login`, `sign_up`, `share`).
- 4 PrestaShop-specific micro-conversions (`apply_voucher`,
  `out_of_stock_alert`, `newsletter_signup`, `review_submitted`).
- Back Office configuration for raw GTM head/body snippets, injection
  toggle, promotions/engagement toggles, and optional GA4 Measurement
  Protocol credentials for server-side refund tracking.
- Purchase deduplication safeguard via a per-order cookie flag.
