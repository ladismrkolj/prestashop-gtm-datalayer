<?php
/**
 * Directory listing guard.
 *
 * This file intentionally contains no module logic. Its sole purpose is to
 * stop web servers from listing the directory contents when accessed
 * directly, matching the convention used across PrestaShop core and
 * modules.
 */

header('Expires: Mon, 26 Jul 1997 05:00:00 GMT');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Cache-Control: post-check=0, pre-check=0', false);
header('Pragma: no-cache');

header('Location: ../');
exit;
