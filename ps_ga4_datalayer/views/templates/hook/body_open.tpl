{**
 * Printed at the start of <body> (see Ps_ga4_datalayer::doDisplayAfterBodyOpeningTag()):
 *  1. GTM <noscript> fallback,
 *  2. first-party data + server-computed page events, each ecommerce push
 *     preceded by {ecommerce: null} as Google requires (GTM merges pushes),
 *  3. the GTM loader - after the consent defaults banners set in <head>.
 * JSON is \u-escaped for <, >, & and quotes, so it cannot break out of the tag.
 *}
{if $ga4_body_snippet|trim != ''}
{$ga4_body_snippet nofilter}
{/if}
<script>
  window.dataLayer = window.dataLayer || [];
  (function (pushes) {
    for (var i = 0; i < pushes.length; i += 1) {
      if (pushes[i].ecommerce) {
        window.dataLayer.push({ ecommerce: null });
      }
      window.dataLayer.push(pushes[i]);
    }
  })({$ga4_pushes_json nofilter});
  window.psGa4Page = {$ga4_page_json nofilter};
</script>
{if $ga4_head_snippet|trim != ''}
{$ga4_head_snippet nofilter}
{/if}
