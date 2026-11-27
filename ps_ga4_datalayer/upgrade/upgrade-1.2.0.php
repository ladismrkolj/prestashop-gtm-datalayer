<?php
/**
 * 1.2.0: all storefront output moved from displayHeader to
 * displayAfterBodyOpeningTag (registered since 1.0.0).
 */
if (!defined('_PS_VERSION_')) {
    exit;
}

function upgrade_module_1_2_0($module)
{
    return $module->unregisterHook('displayHeader');
}
