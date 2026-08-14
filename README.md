# PrestaShop 9 GA4 DataLayer & GTM Module

An open-source, enterprise-grade PrestaShop 9 module that pushes a
comprehensive GA4 `dataLayer` to Google Tag Manager - **23 native events**
covering the entire GA4 eCommerce funnel, extended recommended events,
engagement events, and PrestaShop-specific micro-conversions - with GTM
snippet injection managed entirely from the Back Office.

The installable module lives in [`ps_ga4_datalayer/`](./ps_ga4_datalayer),
including its own [README](./ps_ga4_datalayer/README.md) with full
installation, configuration, architecture and testing instructions.

## Quick facts

- **Target:** PrestaShop 9.x, PHP 8.1-8.4
- **License:** MIT
- **23 events:** 12 core GA4 eCommerce funnel + 3 extended eCommerce + 4
  store engagement + 4 PrestaShop-specific micro-conversions - see the
  [module README](./ps_ga4_datalayer/README.md#the-23-events) for the full
  list and trigger conditions.

## Repository layout

```
.
├── ps_ga4_datalayer/     The PrestaShop module (install this folder)
└── .github/workflows/    CI: PHP/JS syntax linting across PHP 8.1-8.4
```

## Getting started

See [`ps_ga4_datalayer/README.md`](./ps_ga4_datalayer/README.md) for
installation, Back Office configuration, and testing instructions
(Google Tag Assistant, GA4 DebugView, `window.dataLayer` console checks).
