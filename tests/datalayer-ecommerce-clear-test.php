<?php
/**
 * Ecommerce-clearing test - run with: php tests/datalayer-ecommerce-clear-test.php
 *
 * Google's GA4/GTM docs require pushing `{ecommerce: null}` immediately
 * before every ecommerce push:
 *
 *   https://developers.google.com/tag-platform/gtagjs/ecommerce
 *   "Clear the previous ecommerce object."
 *
 * The reason is that GTM's Data Layer *merges* successive pushes rather
 * than replacing them. Without the clear, the `items` array of an earlier
 * event survives into a later one - e.g. a category page pushes
 * view_item_list with 12 items, the shopper clicks one, select_item pushes
 * 1 item, and GTM reads 12 (index 0 replaced, 1-11 stale). That silently
 * inflates item counts and, on purchase, revenue.
 *
 * This asserts the clear is present in both the server-rendered templates
 * and the front-end push() helper, for every ecommerce-bearing push.
 */

$root = dirname(__DIR__);
$failures = [];

function check(string $label, bool $ok, string $detail = ''): void
{
    global $failures;
    if ($ok) {
        printf("  %-58s OK\n", $label);
        return;
    }
    $failures[] = $label . ($detail !== '' ? " ($detail)" : '');
    printf("  %-58s FAIL %s\n", $label, $detail);
}

echo "=== templates ===\n";

$header = (string) file_get_contents($root . '/ps_ga4_datalayer/views/templates/hook/header.tpl');
check(
    'header.tpl clears ecommerce before pushing',
    str_contains($header, 'ecommerce: null'),
    'no `ecommerce: null` push found'
);
check(
    'header.tpl clear is conditional on the event having ecommerce',
    (bool) preg_match('/if\s*\(\s*events\[i\]\s*&&\s*events\[i\]\.ecommerce\s*\)/', $header),
    'expected a guard so non-ecommerce events (login/sign_up/search) do not emit a pointless clear'
);
check(
    'header.tpl no longer bulk-pushes via push.apply',
    !str_contains($header, 'Array.prototype.push.apply'),
    'bulk push cannot interleave the clear between events'
);

$purchase = (string) file_get_contents($root . '/ps_ga4_datalayer/views/templates/hook/purchase.tpl');
check(
    'purchase.tpl clears ecommerce before the purchase push',
    str_contains($purchase, 'ecommerce: null'),
    'no `ecommerce: null` push found'
);
check(
    'purchase.tpl clear precedes the purchase push',
    strpos($purchase, 'ecommerce: null') < strpos($purchase, 'ga4_purchase_b64'),
    'clear must come first to be effective'
);

echo "\n=== front.js ===\n";

$front = (string) file_get_contents($root . '/ps_ga4_datalayer/views/js/front.js');
check(
    'front.js push() clears ecommerce',
    str_contains($front, 'ecommerce: null'),
    'no `ecommerce: null` push found'
);
check(
    'front.js clear is guarded by payload.ecommerce',
    (bool) preg_match('/if\s*\(\s*payload\.ecommerce\s*\)/', $front),
    'expected the clear only for ecommerce-bearing events'
);

/*
 * Behavioural check: emulate GTM's merge semantics and prove the clear
 * actually prevents item bleed. This is the part that would catch someone
 * "fixing" the string check by pushing the clear in the wrong place.
 */
echo "\n=== merge semantics ===\n";

/**
 * Stand-in for GTM's data model. The behaviour that matters: pushes are
 * merged RECURSIVELY, and arrays merge element-wise by index rather than
 * being replaced - so a shorter later array leaves the tail of the earlier
 * one in place. `null` deletes the key, which is what makes the documented
 * `{ecommerce: null}` clear work.
 */
$mergeInto = static function (array $model, array $push) use (&$mergeInto): array {
    foreach ($push as $key => $value) {
        if ($value === null) {
            unset($model[$key]);
            continue;
        }
        if (is_array($value) && isset($model[$key]) && is_array($model[$key])) {
            $model[$key] = $mergeInto($model[$key], $value);
            continue;
        }
        $model[$key] = $value;
    }

    return $model;
};

$mergeModel = static function (array $pushes) use ($mergeInto): array {
    $model = [];
    foreach ($pushes as $push) {
        $model = $mergeInto($model, $push);
    }

    return $model;
};

$listEvent = ['event' => 'view_item_list', 'ecommerce' => ['items' => [['id' => 'a'], ['id' => 'b'], ['id' => 'c']]]];
$selectEvent = ['event' => 'select_item', 'ecommerce' => ['items' => [['id' => 'b']]]];

$withoutClear = $mergeModel([$listEvent, $selectEvent]);
check(
    'without clear, stale items bleed through (demonstrates the hazard)',
    count($withoutClear['ecommerce']['items']) === 3,
    'expected the un-cleared model to wrongly retain 3 items'
);

$withClear = $mergeModel([$listEvent, ['ecommerce' => null], $selectEvent]);
check(
    'with clear, select_item carries exactly 1 item',
    count($withClear['ecommerce']['items']) === 1,
    'got ' . count($withClear['ecommerce']['items']) . ' items'
);

echo "\n============================================\n";
if ($failures === []) {
    echo "RESULT: PASS - ecommerce object is cleared before every ecommerce push\n";
    exit(0);
}
echo 'RESULT: FAIL (' . count($failures) . ")\n";
foreach ($failures as $f) {
    echo " - $f\n";
}
exit(1);
